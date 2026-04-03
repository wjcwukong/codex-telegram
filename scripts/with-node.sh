#!/bin/sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "usage: ./scripts/with-node.sh <node-args...>" >&2
  exit 1
fi

if [ -n "${NODE_BINARY:-}" ]; then
  exec "$NODE_BINARY" "$@"
fi

for candidate in $(which -a node 2>/dev/null); do
  case "$candidate" in
    */.bun/bin/node)
      continue
      ;;
  esac
  exec "$candidate" "$@"
done

echo "Unable to find a real Node.js binary. Bun's node shim is first on PATH; install Node or set NODE_BINARY." >&2
exit 1
