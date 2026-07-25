# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /build
COPY . .

RUN npm ci --ignore-scripts \
  && npm run build:web \
  && npm run build:task-board

FROM caddy:2-alpine AS caddy

FROM node:24-alpine AS runtime

RUN apk add --no-cache su-exec tini

WORKDIR /app

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /build/packages/task-board-contract/package.json ./packages/task-board-contract/package.json
COPY --from=build /build/packages/task-board-contract/dist ./packages/task-board-contract/dist
COPY --from=build /build/services/task-board/package.json ./services/task-board/package.json
COPY --from=build /build/services/task-board/dist ./services/task-board/dist

RUN mkdir -p /app/node_modules/@cicada /srv/steward /var/lib/steward/private \
  && ln -s ../../packages/task-board-contract /app/node_modules/@cicada/steward-task-board-contract \
  && chown -R node:node /var/lib/steward \
  && chmod 0700 /var/lib/steward /var/lib/steward/private

COPY --from=build /build/dist /srv/steward
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/entrypoint.sh /app/deploy/entrypoint.sh

ENV NODE_ENV=production \
    STEWARD_TASK_BOARD_DB_PATH=/var/lib/steward/private/board.sqlite \
    STEWARD_TASK_BOARD_HOST=127.0.0.1 \
    STEWARD_TASK_BOARD_PORT=4318

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "-g", "--", "/app/deploy/entrypoint.sh"]
