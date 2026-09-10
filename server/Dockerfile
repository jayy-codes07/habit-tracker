# Multi-stage: the runtime image carries production dependencies and source only,
# never dev dependencies, tests or tooling.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000
USER node

# Direct exec of node, so it is PID 1 and receives SIGTERM for graceful shutdown.
CMD ["node", "src/server.js"]
