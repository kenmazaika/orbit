#!/usr/bin/env bash
# Roll back the Orbit object model.
#
# Drops ONLY obj_* tables. Never names cards, actions, events, or poc_*.
# Dry run by default; execution requires --yes-drop. Remote requires --yes-remote too.
set -euo pipefail

CONFIG="${ORBIT_OBJECTS_CONFIG:-wrangler.objects.local.json}"
TARGET="--local"
REMOTE=0
YES_REMOTE=0
DROP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --local) TARGET="--local"; shift ;;
    --remote) TARGET="--remote"; REMOTE=1; shift ;;
    --yes-remote) YES_REMOTE=1; shift ;;
    --yes-drop) DROP=1; shift ;;
    --config) CONFIG="$2"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$REMOTE" = 1 ] && [ "$YES_REMOTE" != 1 ]; then
  echo "refusing remote rollback: pass --yes-remote to confirm the target database" >&2
  exit 3
fi

SQL="DROP TABLE IF EXISTS obj_agent_actions;
DROP TABLE IF EXISTS obj_events;
DROP TABLE IF EXISTS obj_relationships;
DROP TABLE IF EXISTS obj_revisions;
DROP TABLE IF EXISTS obj_objects;
DROP TABLE IF EXISTS obj_workspaces;
DROP TABLE IF EXISTS obj_meta;"

cd "$(dirname "$0")/.."

echo "config: $CONFIG"
echo "target: ${TARGET#--}"
echo "--- SQL ---"
echo "$SQL"
echo "-----------"

if [ "$DROP" != 1 ]; then
  echo "dry run — nothing executed. Re-run with --yes-drop to drop these tables."
  exit 0
fi

if [ "$REMOTE" = 1 ]; then
  echo "DROPPING obj_* tables in the REMOTE database (ORBIT_OBJECTS_DB)"
fi

npx wrangler d1 execute ORBIT_OBJECTS_DB --config "$CONFIG" "$TARGET" --command "$SQL"
echo "done — obj_* tables dropped; live Orbit tables untouched"
