#!/bin/sh
set -eu

# A new Docker volume is normally populated with the image's ownership. Repair
# it explicitly as well so restores and recreated volumes remain owner-only.
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /var/lib/steward/private
  chown node:node /var/lib/steward /var/lib/steward/private
  chmod 0700 /var/lib/steward /var/lib/steward/private
  exec su-exec node:node "$0" "$@"
fi

board_pid=""
gateway_pid=""
stopping=0

stop_processes() {
  if [ "$stopping" -eq 1 ]; then
    return
  fi
  stopping=1

  if [ -n "$gateway_pid" ]; then
    kill -TERM "$gateway_pid" 2>/dev/null || true
  fi
  if [ -n "$board_pid" ]; then
    kill -TERM "$board_pid" 2>/dev/null || true
  fi

  set +e
  if [ -n "$gateway_pid" ]; then
    wait "$gateway_pid" 2>/dev/null
  fi
  if [ -n "$board_pid" ]; then
    wait "$board_pid" 2>/dev/null
  fi
  set -e
}

on_signal() {
  stop_processes
  exit 0
}

trap on_signal INT TERM
trap stop_processes EXIT

node /app/services/task-board/dist/src/main.js &
board_pid=$!

attempt=0
while ! wget -q -T 1 -O /dev/null http://127.0.0.1:4318/health; do
  if ! kill -0 "$board_pid" 2>/dev/null; then
    set +e
    wait "$board_pid"
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      status=1
    fi
    echo "Steward task board exited before becoming ready" >&2
    exit "$status"
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Steward task board did not become ready within 30 seconds" >&2
    exit 1
  fi
  sleep 1
done

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
gateway_pid=$!

while kill -0 "$board_pid" 2>/dev/null && kill -0 "$gateway_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$board_pid" 2>/dev/null; then
  set +e
  wait "$board_pid"
  status=$?
  set -e
  echo "Steward task board exited unexpectedly" >&2
else
  set +e
  wait "$gateway_pid"
  status=$?
  set -e
  echo "Steward web gateway exited unexpectedly" >&2
fi

if [ "$status" -eq 0 ]; then
  status=1
fi
exit "$status"
