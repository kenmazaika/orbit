#!/usr/bin/env bash
# Apply Orbit object-model migrations.
#
# Local by default. Remote is opt-in twice: --remote AND --yes-remote.
# Never touches cards/actions/events/poc_* — every migration is additive obj_*.
set -euo pipefail

CONFIG="${ORBIT_OBJECTS_CONFIG:-wrangler.objects.local.json}"
TARGET="--local"
REMOTE=0
YES_REMOTE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --local) TARGET="--local"; shift ;;
    --remote) TARGET="--remote"; REMOTE=1; shift ;;
    --yes-remote) YES_REMOTE=1; shift ;;
    --config) CONFIG="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$REMOTE" = 1 ] && [ "$YES_REMOTE" != 1 ]; then
  echo "refusing remote migration: pass --yes-remote to confirm the target database" >&2
  exit 3
fi

cd "$(dirname "$0")/.."

echo "config: $CONFIG"
echo "target: ${TARGET#--}"
if [ "$REMOTE" = 1 ]; then
  echo "database binding: ORBIT_OBJECTS_DB (confirm this points at the intended database)"
fi

FILES=$(ls -1 migrations/objects/*.sql | sort)
if [ -z "$FILES" ]; then echo "no migrations found" >&2; exit 4; fi

for f in $FILES; do
  echo "applying $f"
  npx wrangler d1 execute ORBIT_OBJECTS_DB --config "$CONFIG" "$TARGET" --file "$f"
done

echo "done — object-model migrations applied (${TARGET#--})"
