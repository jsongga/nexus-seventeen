# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build

COPY . .
RUN npm run build

FROM caddy:2-alpine AS caddy

FROM node:24-alpine AS runtime

RUN apk add --no-cache su-exec tini

WORKDIR /app

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/build ./build
COPY --from=build /build/skills ./skills

RUN mkdir -p /srv/steward /var/lib/steward/private \
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

FROM node:24-alpine AS agent

ARG CODEX_CLI_VERSION
ARG CLAUDE_CLI_VERSION

RUN apk add --no-cache git tini

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"

LABEL steward.cli.codex="${CODEX_CLI_VERSION}" \
      steward.cli.claude="${CLAUDE_CLI_VERSION}"

COPY --from=deps /build/node_modules /opt/steward/node_modules
COPY --from=deps /build/package-lock.json /opt/steward/package-lock.json
COPY --from=build /build/build /opt/steward/build
COPY --from=build /build/build/server/agents/task-worker/agent-result.schema.json /opt/steward/agent-result.schema.json
COPY --chmod=0755 deploy/agent/stub-codex.mjs /usr/local/bin/steward-stub
COPY --chmod=0755 deploy/agent/entrypoint.sh /opt/steward/agent-entrypoint.sh

ENTRYPOINT ["/sbin/tini", "-g", "--", "/opt/steward/agent-entrypoint.sh"]
