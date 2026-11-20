# Atimtha web app (Angular). Build from web/:
#   docker build -t atimtha/web:dev web
# Runtime settings (environment variables):
#   ATIMTHA_OIDC_ISSUER       the identity provider (https://…), required for sign-in
#   ATIMTHA_OIDC_CLIENT_ID    default atimtha-web
#   ATIMTHA_API_UPSTREAM      the platform API, default http://api:8080
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run lint:i18n && npx ng build --configuration production

# non-root nginx, listening on 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /src/dist/atimtha-web/browser /usr/share/nginx/html
COPY docker/default.conf.template docker/security-headers.inc.template /etc/nginx/templates/
COPY docker/05-atimtha-config.envsh /docker-entrypoint.d/
USER root
# security fixes published after the base image was built (e.g. OpenSSL, Brotli); config.js is rewritten at start
# by the (non-root) nginx user
RUN apk upgrade --no-cache \
    && chmod 0755 /docker-entrypoint.d/05-atimtha-config.envsh \
    && rm -f /etc/nginx/conf.d/default.conf \
    && chown 101:101 /usr/share/nginx/html/config.js
USER 101
ENV ATIMTHA_API_UPSTREAM=http://api:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
