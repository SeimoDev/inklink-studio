#include "offline_scene.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crc32.h"
#include "esp_partition.h"

#define SCENE_MAGIC 0x534b4e49U
#define SCENE_VERSION 1U
#define SCENE_HEADER_BYTES 16U
#define SCENE_MAX_FONTS 8U
#define SCENE_MAX_LAYERS 32U
#define SCENE_MAX_GLYPHS 128U
#define SCENE_MAX_TEXT_BYTES 1024U

#define STORED_SCENE_MAGIC 0x314e4353U

typedef enum {
    SCENE_SENSOR_BATTERY_MV = 0,
    SCENE_SENSOR_BATTERY_PERCENT = 1,
    SCENE_SENSOR_CHIP_TEMPERATURE = 2,
    SCENE_SENSOR_VBUS_PRESENT = 3,
    SCENE_SENSOR_UPTIME = 4,
    SCENE_SENSOR_FREE_HEAP = 5,
    SCENE_SENSOR_STATIC = 255,
} scene_sensor_id_t;

typedef struct {
    const uint8_t *data;
    size_t length;
    size_t offset;
} cursor_t;

typedef struct {
    uint16_t height;
    uint16_t glyph_count;
    const uint8_t *glyphs;
} scene_font_t;

typedef struct {
    uint8_t sensor_id;
    uint8_t font_index;
    int16_t x;
    int16_t y;
    uint8_t padding;
    uint8_t foreground;
    uint8_t background;
    uint8_t decimals;
    const uint8_t *prefix;
    uint16_t prefix_length;
    const uint8_t *suffix;
    uint16_t suffix_length;
    const uint8_t *fallback;
    uint16_t fallback_length;
    const uint8_t *static_value;
    uint16_t static_value_length;
} scene_layer_t;

typedef struct {
    epd_rotation_t rotation;
    const uint8_t *base_frame;
    uint8_t font_count;
    uint8_t layer_count;
    scene_font_t fonts[SCENE_MAX_FONTS];
    scene_layer_t layers[SCENE_MAX_LAYERS];
} scene_view_t;

typedef struct {
    uint32_t magic;
    uint32_t length;
    uint32_t crc32;
} stored_scene_header_t;

typedef struct {
    uint32_t code_point;
    uint16_t width;
    uint16_t advance;
    uint16_t bits_length;
    const uint8_t *bits;
} glyph_view_t;

static const esp_partition_t *s_partition;
static uint8_t *s_scene_data;
static size_t s_scene_length;

static bool cursor_take(cursor_t *cursor, size_t length, const uint8_t **data)
{
    if (length > cursor->length - cursor->offset) {
        return false;
    }
    if (data != NULL) {
        *data = cursor->data + cursor->offset;
    }
    cursor->offset += length;
    return true;
}

static bool cursor_u8(cursor_t *cursor, uint8_t *value)
{
    const uint8_t *data = NULL;
    if (!cursor_take(cursor, 1, &data)) return false;
    *value = data[0];
    return true;
}

static bool cursor_u16(cursor_t *cursor, uint16_t *value)
{
    const uint8_t *data = NULL;
    if (!cursor_take(cursor, 2, &data)) return false;
    *value = (uint16_t)data[0] | (uint16_t)((uint16_t)data[1] << 8);
    return true;
}

static bool cursor_i16(cursor_t *cursor, int16_t *value)
{
    uint16_t raw = 0;
    if (!cursor_u16(cursor, &raw)) return false;
    *value = (int16_t)raw;
    return true;
}

static bool cursor_u32(cursor_t *cursor, uint32_t *value)
{
    const uint8_t *data = NULL;
    if (!cursor_take(cursor, 4, &data)) return false;
    *value = (uint32_t)data[0] |
        ((uint32_t)data[1] << 8) |
        ((uint32_t)data[2] << 16) |
        ((uint32_t)data[3] << 24);
    return true;
}

static bool sensor_id_valid(uint8_t sensor_id)
{
    return sensor_id <= SCENE_SENSOR_FREE_HEAP ||
        sensor_id == SCENE_SENSOR_STATIC;
}

static bool parse_scene(
    const uint8_t *data,
    size_t length,
    scene_view_t *view
)
{
    if (data == NULL || view == NULL || length < SCENE_HEADER_BYTES + EPD_FRAME_BYTES) {
        return false;
    }

    memset(view, 0, sizeof(*view));
    cursor_t cursor = {.data = data, .length = length};
    uint32_t magic = 0;
    uint16_t version = 0;
    uint16_t header_bytes = 0;
    uint16_t rotation = 0;
    uint16_t frame_bytes = 0;
    uint16_t reserved = 0;
    if (!cursor_u32(&cursor, &magic) ||
        !cursor_u16(&cursor, &version) ||
        !cursor_u16(&cursor, &header_bytes) ||
        !cursor_u16(&cursor, &rotation) ||
        !cursor_u8(&cursor, &view->font_count) ||
        !cursor_u8(&cursor, &view->layer_count) ||
        !cursor_u16(&cursor, &frame_bytes) ||
        !cursor_u16(&cursor, &reserved)) {
        return false;
    }
    if (magic != SCENE_MAGIC || version != SCENE_VERSION ||
        header_bytes != SCENE_HEADER_BYTES || frame_bytes != EPD_FRAME_BYTES ||
        (rotation != EPD_ROTATE_90 && rotation != EPD_ROTATE_270) ||
        view->font_count > SCENE_MAX_FONTS ||
        view->layer_count > SCENE_MAX_LAYERS) {
        return false;
    }
    (void)reserved;
    view->rotation = (epd_rotation_t)rotation;
    if (!cursor_take(&cursor, EPD_FRAME_BYTES, &view->base_frame)) {
        return false;
    }

    for (uint8_t font_index = 0; font_index < view->font_count; ++font_index) {
        scene_font_t *font = &view->fonts[font_index];
        if (!cursor_u16(&cursor, &font->height) ||
            !cursor_u16(&cursor, &font->glyph_count) ||
            font->height == 0 || font->height > 120 ||
            font->glyph_count > SCENE_MAX_GLYPHS) {
            return false;
        }
        font->glyphs = cursor.data + cursor.offset;
        for (uint16_t glyph_index = 0; glyph_index < font->glyph_count; ++glyph_index) {
            uint32_t code_point = 0;
            uint16_t width = 0;
            uint16_t advance = 0;
            uint16_t bits_length = 0;
            if (!cursor_u32(&cursor, &code_point) ||
                !cursor_u16(&cursor, &width) ||
                !cursor_u16(&cursor, &advance) ||
                !cursor_u16(&cursor, &bits_length) ||
                code_point > 0x10ffffU || width == 0 || width > 192 ||
                advance > 192 ||
                bits_length != (uint16_t)(((width + 7U) / 8U) * font->height) ||
                !cursor_take(&cursor, bits_length, NULL)) {
                return false;
            }
        }
    }

    for (uint8_t layer_index = 0; layer_index < view->layer_count; ++layer_index) {
        scene_layer_t *layer = &view->layers[layer_index];
        uint16_t lengths[4] = {0};
        if (!cursor_u8(&cursor, &layer->sensor_id) ||
            !cursor_u8(&cursor, &layer->font_index) ||
            !cursor_i16(&cursor, &layer->x) ||
            !cursor_i16(&cursor, &layer->y) ||
            !cursor_u8(&cursor, &layer->padding) ||
            !cursor_u8(&cursor, &layer->foreground) ||
            !cursor_u8(&cursor, &layer->background) ||
            !cursor_u8(&cursor, &layer->decimals)) {
            return false;
        }
        for (size_t field = 0; field < 4; ++field) {
            if (!cursor_u16(&cursor, &lengths[field]) ||
                lengths[field] > SCENE_MAX_TEXT_BYTES) {
                return false;
            }
        }
        if (!sensor_id_valid(layer->sensor_id) ||
            layer->font_index >= view->font_count ||
            layer->foreground > 1 || layer->background > 2 ||
            layer->decimals > 4 ||
            !cursor_take(&cursor, lengths[0], &layer->prefix) ||
            !cursor_take(&cursor, lengths[1], &layer->suffix) ||
            !cursor_take(&cursor, lengths[2], &layer->fallback) ||
            !cursor_take(&cursor, lengths[3], &layer->static_value)) {
            return false;
        }
        layer->prefix_length = lengths[0];
        layer->suffix_length = lengths[1];
        layer->fallback_length = lengths[2];
        layer->static_value_length = lengths[3];
    }

    return cursor.offset == cursor.length;
}

static bool font_find_glyph(
    const scene_font_t *font,
    uint32_t code_point,
    glyph_view_t *glyph
)
{
    cursor_t cursor = {
        .data = font->glyphs,
        .length = s_scene_length - (size_t)(font->glyphs - s_scene_data),
    };
    for (uint16_t index = 0; index < font->glyph_count; ++index) {
        glyph_view_t candidate = {0};
        if (!cursor_u32(&cursor, &candidate.code_point) ||
            !cursor_u16(&cursor, &candidate.width) ||
            !cursor_u16(&cursor, &candidate.advance) ||
            !cursor_u16(&cursor, &candidate.bits_length) ||
            !cursor_take(&cursor, candidate.bits_length, &candidate.bits)) {
            return false;
        }
        if (candidate.code_point == code_point) {
            *glyph = candidate;
            return true;
        }
    }
    return false;
}

static bool utf8_next(
    const uint8_t *text,
    size_t length,
    size_t *offset,
    uint32_t *code_point
)
{
    if (*offset >= length) return false;
    const uint8_t first = text[(*offset)++];
    if (first < 0x80) {
        *code_point = first;
        return true;
    }

    uint32_t value = 0;
    unsigned continuation = 0;
    if ((first & 0xe0U) == 0xc0U) {
        value = first & 0x1fU;
        continuation = 1;
    } else if ((first & 0xf0U) == 0xe0U) {
        value = first & 0x0fU;
        continuation = 2;
    } else if ((first & 0xf8U) == 0xf0U) {
        value = first & 0x07U;
        continuation = 3;
    } else {
        *code_point = 0xfffdU;
        return true;
    }
    if (continuation > length - *offset) {
        *offset = length;
        *code_point = 0xfffdU;
        return true;
    }
    for (unsigned index = 0; index < continuation; ++index) {
        const uint8_t byte = text[(*offset)++];
        if ((byte & 0xc0U) != 0x80U) {
            *code_point = 0xfffdU;
            return true;
        }
        value = (value << 6) | (byte & 0x3fU);
    }
    *code_point = value;
    return true;
}

static void set_frame_pixel(uint8_t *frame, int x, int y, bool white)
{
    if (x < 0 || x >= EPD_LANDSCAPE_WIDTH ||
        y < 0 || y >= EPD_LANDSCAPE_HEIGHT) {
        return;
    }
    const size_t index = (size_t)y * (EPD_LANDSCAPE_WIDTH / 8) + (size_t)x / 8;
    const uint8_t mask = (uint8_t)(0x80U >> (x & 7));
    if (white) frame[index] |= mask;
    else frame[index] &= (uint8_t)~mask;
}

static void fill_rectangle(
    uint8_t *frame,
    int x,
    int y,
    int width,
    int height,
    bool white
)
{
    for (int row = 0; row < height; ++row) {
        for (int column = 0; column < width; ++column) {
            set_frame_pixel(frame, x + column, y + row, white);
        }
    }
}

static int text_width(
    const scene_font_t *font,
    const uint8_t *text,
    size_t length
)
{
    int width = 0;
    size_t offset = 0;
    uint32_t code_point = 0;
    while (utf8_next(text, length, &offset, &code_point)) {
        glyph_view_t glyph = {0};
        if (font_find_glyph(font, code_point, &glyph)) {
            width += glyph.advance;
        }
    }
    return width;
}

static int draw_text(
    uint8_t *frame,
    const scene_font_t *font,
    const uint8_t *text,
    size_t length,
    int x,
    int y,
    bool white
)
{
    size_t offset = 0;
    uint32_t code_point = 0;
    int cursor_x = x;
    while (utf8_next(text, length, &offset, &code_point)) {
        glyph_view_t glyph = {0};
        if (!font_find_glyph(font, code_point, &glyph)) continue;
        const size_t stride = (glyph.width + 7U) / 8U;
        for (uint16_t row = 0; row < font->height; ++row) {
            for (uint16_t column = 0; column < glyph.width; ++column) {
                const uint8_t bit = (uint8_t)(0x80U >> (column & 7));
                if ((glyph.bits[(size_t)row * stride + column / 8U] & bit) != 0) {
                    set_frame_pixel(frame, cursor_x + column, y + row, white);
                }
            }
        }
        cursor_x += glyph.advance;
    }
    return cursor_x;
}

static void format_duration(uint32_t total_seconds, char *buffer, size_t length)
{
    const uint32_t days = total_seconds / 86400U;
    const uint32_t hours = (total_seconds % 86400U) / 3600U;
    const uint32_t minutes = (total_seconds % 3600U) / 60U;
    const uint32_t seconds = total_seconds % 60U;
    if (days > 0) {
        snprintf(buffer, length, "%lu天 %lu小时", (unsigned long)days, (unsigned long)hours);
    } else if (hours > 0) {
        snprintf(buffer, length, "%lu小时 %lu分", (unsigned long)hours, (unsigned long)minutes);
    } else if (minutes > 0) {
        snprintf(buffer, length, "%lu分 %lu秒", (unsigned long)minutes, (unsigned long)seconds);
    } else {
        snprintf(buffer, length, "%lu秒", (unsigned long)seconds);
    }
}

static bool format_sensor(
    const scene_layer_t *layer,
    const sensor_snapshot_t *snapshot,
    char *buffer,
    size_t length
)
{
    switch (layer->sensor_id) {
    case SCENE_SENSOR_BATTERY_MV:
        if (!snapshot->battery_valid) return false;
        snprintf(buffer, length, "%.*f", layer->decimals, snapshot->battery_mv / 1000.0);
        return true;
    case SCENE_SENSOR_BATTERY_PERCENT:
        if (!snapshot->battery_valid) return false;
        snprintf(buffer, length, "%.*f", layer->decimals, (double)snapshot->battery_percent);
        return true;
    case SCENE_SENSOR_CHIP_TEMPERATURE:
        if (!snapshot->temperature_valid) return false;
        snprintf(buffer, length, "%.*f", layer->decimals, (double)snapshot->chip_temperature_c);
        return true;
    case SCENE_SENSOR_VBUS_PRESENT:
        snprintf(buffer, length, "%s", snapshot->vbus_present ? "已连接" : "未连接");
        return true;
    case SCENE_SENSOR_UPTIME:
        format_duration(snapshot->uptime_s, buffer, length);
        return true;
    case SCENE_SENSOR_FREE_HEAP:
        snprintf(buffer, length, "%.*f", layer->decimals, snapshot->free_heap / 1024.0);
        return true;
    default:
        return false;
    }
}

static void render_layer(
    uint8_t *frame,
    const scene_view_t *view,
    const scene_layer_t *layer,
    const sensor_snapshot_t *snapshot
)
{
    const scene_font_t *font = &view->fonts[layer->font_index];
    char formatted[64] = {0};
    const uint8_t *value = layer->static_value;
    size_t value_length = layer->static_value_length;
    if (layer->sensor_id != SCENE_SENSOR_STATIC) {
        if (format_sensor(layer, snapshot, formatted, sizeof(formatted))) {
            value = (const uint8_t *)formatted;
            value_length = strlen(formatted);
        } else {
            value = layer->fallback;
            value_length = layer->fallback_length;
        }
    }

    const int content_width =
        text_width(font, layer->prefix, layer->prefix_length) +
        text_width(font, value, value_length) +
        text_width(font, layer->suffix, layer->suffix_length);
    if (layer->background != 0) {
        fill_rectangle(
            frame,
            layer->x,
            layer->y,
            content_width + layer->padding * 2,
            font->height + layer->padding * 2,
            layer->background == 1
        );
    }

    int x = layer->x + layer->padding;
    const int y = layer->y + layer->padding;
    const bool white = layer->foreground == 1;
    x = draw_text(frame, font, layer->prefix, layer->prefix_length, x, y, white);
    x = draw_text(frame, font, value, value_length, x, y, white);
    (void)draw_text(frame, font, layer->suffix, layer->suffix_length, x, y, white);
}

static const esp_partition_t *scene_partition(void)
{
    if (s_partition == NULL) {
        s_partition = esp_partition_find_first(
            ESP_PARTITION_TYPE_DATA,
            ESP_PARTITION_SUBTYPE_ANY,
            "scene"
        );
    }
    return s_partition;
}

esp_err_t offline_scene_init(void)
{
    const esp_partition_t *partition = scene_partition();
    if (partition == NULL) return ESP_ERR_NOT_FOUND;

    stored_scene_header_t header = {0};
    esp_err_t result = esp_partition_read(partition, 0, &header, sizeof(header));
    if (result != ESP_OK) return result;
    if (header.magic != STORED_SCENE_MAGIC) return ESP_ERR_NOT_FOUND;
    if (header.length < SCENE_HEADER_BYTES + EPD_FRAME_BYTES ||
        header.length > OFFLINE_SCENE_MAX_BYTES ||
        sizeof(header) + header.length > partition->size) {
        return ESP_ERR_INVALID_SIZE;
    }

    uint8_t *data = malloc(header.length);
    if (data == NULL) return ESP_ERR_NO_MEM;
    result = esp_partition_read(partition, sizeof(header), data, header.length);
    scene_view_t view;
    if (result != ESP_OK || ink_crc32(data, header.length) != header.crc32 ||
        !parse_scene(data, header.length, &view)) {
        free(data);
        return result == ESP_OK ? ESP_ERR_INVALID_CRC : result;
    }

    free(s_scene_data);
    s_scene_data = data;
    s_scene_length = header.length;
    return ESP_OK;
}

esp_err_t offline_scene_install(uint8_t *data, size_t length)
{
    if (data == NULL || length > OFFLINE_SCENE_MAX_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }
    scene_view_t view;
    if (!parse_scene(data, length, &view)) return ESP_ERR_INVALID_ARG;

    const esp_partition_t *partition = scene_partition();
    if (partition == NULL) return ESP_ERR_NOT_FOUND;
    const size_t stored_length = sizeof(stored_scene_header_t) + length;
    if (stored_length > partition->size) return ESP_ERR_INVALID_SIZE;
    const size_t erase_length =
        (stored_length + partition->erase_size - 1U) /
        partition->erase_size * partition->erase_size;
    esp_err_t result = esp_partition_erase_range(partition, 0, erase_length);
    if (result != ESP_OK) return result;

    const stored_scene_header_t header = {
        .magic = STORED_SCENE_MAGIC,
        .length = (uint32_t)length,
        .crc32 = ink_crc32(data, length),
    };
    result = esp_partition_write(partition, 0, &header, sizeof(header));
    if (result == ESP_OK) {
        result = esp_partition_write(partition, sizeof(header), data, length);
    }
    if (result != ESP_OK) return result;

    free(s_scene_data);
    s_scene_data = data;
    s_scene_length = length;
    return ESP_OK;
}

esp_err_t offline_scene_clear(void)
{
    free(s_scene_data);
    s_scene_data = NULL;
    s_scene_length = 0;
    const esp_partition_t *partition = scene_partition();
    if (partition == NULL) return ESP_ERR_NOT_FOUND;
    return esp_partition_erase_range(partition, 0, partition->erase_size);
}

bool offline_scene_available(void)
{
    return s_scene_data != NULL && s_scene_length > 0;
}

esp_err_t offline_scene_render(
    const sensor_snapshot_t *snapshot,
    uint8_t *frame,
    epd_rotation_t *rotation
)
{
    if (snapshot == NULL || frame == NULL || rotation == NULL ||
        !offline_scene_available()) {
        return ESP_ERR_INVALID_STATE;
    }
    scene_view_t view;
    if (!parse_scene(s_scene_data, s_scene_length, &view)) {
        return ESP_ERR_INVALID_STATE;
    }
    memcpy(frame, view.base_frame, EPD_FRAME_BYTES);
    for (uint8_t index = 0; index < view.layer_count; ++index) {
        render_layer(frame, &view, &view.layers[index], snapshot);
    }
    *rotation = view.rotation;
    return ESP_OK;
}
