# Preview image for Vercel Sandbox PR environments.
# Builds the plugin frontend and Go backend, then bakes the resulting dist/
# into a stock Grafana image. Unlike .config/Dockerfile this has no hot reload,
# delve, or supervisord: it just serves the built plugin.

# ---- Frontend build ----------------------------------------------------------
FROM node:24.15.0-bookworm AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Backend build -----------------------------------------------------------
FROM golang:1.26-bookworm AS backend
WORKDIR /app
RUN go install github.com/magefile/mage@latest
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Vercel Sandbox only runs in the iad1 region (linux/amd64), so we build a
# single arch. Grafana resolves the executable as gpx_clickhouse_<os>_<arch> at
# runtime; amd64 is all the sandbox needs. Produces dist/gpx_clickhouse_linux_amd64.
RUN mage -v build:linux

# ---- Runtime image -----------------------------------------------------------
FROM grafana/grafana-enterprise:12.4.2

# Public previews with no login at all: the login form and basic auth are both
# disabled, so every visitor is the shared anonymous session and no credentials
# are exposed. Anonymous access is granted at the Editor role so reviewers can use
# Explore and the query editor to exercise plugin changes (no org/server admin).
ENV GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Editor \
    GF_AUTH_DISABLE_LOGIN_FORM=true \
    GF_AUTH_DISABLE_SIGNOUT_MENU=true \
    GF_AUTH_BASIC_ENABLED=false \
    GF_DEFAULT_APP_MODE=development \
    GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=grafana-clickhouse-datasource

COPY --from=frontend --chown=grafana:root /app/dist /var/lib/grafana/plugins/grafana-clickhouse-datasource
COPY --from=backend --chown=grafana:root /app/dist/gpx_clickhouse_linux_* /var/lib/grafana/plugins/grafana-clickhouse-datasource/
COPY --chown=grafana:root preview/provisioning /etc/grafana/provisioning
