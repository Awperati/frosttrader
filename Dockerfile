# FrostTrader's server, headless, for the Raspberry Pi (linux/arm64) or any Linux box: the same
# server/app.mjs the Windows app runs, with the paper agents. docs/PI.md is the runbook.
#
# Build stage: the client (vite). Install scripts are skipped, so Electron's binary is not fetched.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client ./client
RUN npx vite build --config client/vite.config.ts

# Run stage: the server has no npm dependencies (node: builtins only).
FROM node:24-alpine
RUN apk add --no-cache su-exec tzdata
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/frosttrader-entrypoint
RUN chmod +x /usr/local/bin/frosttrader-entrypoint && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 TICKER_MIRROR=0
ENTRYPOINT ["frosttrader-entrypoint"]
CMD ["node", "server/index.mjs"]
