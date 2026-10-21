#!/bin/sh
# If Docker created ./data as root (e.g. compose ran before `mkdir data`),
# hand it to the node user so the server can write data.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}"
  exec su-exec node "$@"
fi
exec "$@"
