#!/usr/bin/env bash
# Apply the single source-controlled migration history to STAGING only.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="orbit-staging"
if ! grep -q '"database_name": "orbit-staging"' wrangler.staging.json; then
  echo "REFUSING: staging config does not bind orbit-staging" >&2; exit 1
fi
for f in migrations/objects/0001_objects_core.sql migrations/objects/0002_artifacts.sql \
         migrations/objects/0003_inbox.sql migrations/objects/0004_dispatches.sql \
         migrations/objects/0005_image_roles.sql migrations/objects/0006_action_lifecycle.sql \
         migrations/objects/0007_masthead_publication.sql schema.sql; do
  echo "--- $f -> $DB"
  npx wrangler d1 execute "$DB" --remote --file="$f"
done
echo "staging migrations complete."
