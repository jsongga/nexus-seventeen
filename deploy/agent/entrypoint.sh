#!/bin/sh
set -eu
if [ -f /workspace/package.json ] && [ ! -e /workspace/node_modules ]; then
  ln -s /opt/steward/node_modules /workspace/node_modules
fi
exec "$@"
