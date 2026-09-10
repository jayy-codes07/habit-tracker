# Multi-stage: the runtime image carries production dependencies and source only,
# never dev dependencies, tests or tooling.
#
# The build context is the repository root rather than server/, because in
# production one origin serves both the API and the built SPA — and a context
# rooted at server/ cannot see web/ at all.

# Selects which stage supplies the SPA. Declared before the first FROM so it can
# be used in one. See the web stages below.
ARG WEB_STAGE=web-empty

FROM node:20-alpine AS deps
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# --- the SPA ---------------------------------------------------------------
#
# web/ does not exist yet. Docker builds only the stages its target depends on,
# so the default keeps web-build out of the graph entirely and its COPY of a
# missing directory never runs — the image builds today and gains the frontend
# with no Dockerfile change. Once web/ exists, build it with:
#
#   docker build --build-arg WEB_STAGE=web-build -f server/Dockerfile .

# node:20-alpine rather than plain alpine: this stage only needs mkdir, but the
# image is already pulled for the stages below, so reusing it adds no layer and
# no floating tag. Every base here is pinned to the same one on purpose.
FROM node:20-alpine AS web-empty
RUN mkdir -p /web/dist

FROM node:20-alpine AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ${WEB_STAGE} AS web

# --- runtime ---------------------------------------------------------------

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Absolute on purpose: config resolves this against the repository root, which
# does not exist inside the image. An empty directory here simply means no
# frontend, and the API serves its placeholder instead.
ENV WEB_DIST_PATH=/app/web/dist

COPY --from=deps /app/node_modules ./node_modules
COPY server/package*.json ./
COPY server/src ./src
COPY server/scripts ./scripts
COPY --from=web /web/dist ./web/dist

EXPOSE 3000
USER node

# Direct exec of node, so it is PID 1 and receives SIGTERM for graceful shutdown.
CMD ["node", "src/server.js"]
