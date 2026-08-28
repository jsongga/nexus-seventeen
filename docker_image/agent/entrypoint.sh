#!/bin/sh
set -eu
if [ -f /workspace/package.json ] \
  && [ -f /workspace/package-lock.json ] \
  && [ -f /opt/steward/package-lock.json ] \
  && [ ! -e /workspace/node_modules ] \
  && cmp -s /workspace/package-lock.json /opt/steward/package-lock.json; then
  ln -s /opt/steward/node_modules /workspace/node_modules
fi
exec "$@"
