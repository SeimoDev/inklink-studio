FROM node:22-alpine AS web-build

WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist/ /usr/share/nginx/html/

RUN chown -R nginx:nginx \
    /etc/nginx/conf.d \
    /usr/share/nginx/html \
    /var/cache/nginx \
    /var/run

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

