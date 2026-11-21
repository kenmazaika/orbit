#!/usr/bin/env bash
# Reset and seed the STAGING database only. Refuses anything not named orbit-staging.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="orbit-staging"
CONFIG="wrangler.staging.json"
if ! grep -q '"database_name": "orbit-staging"' "$CONFIG"; then
  echo "REFUSING: $CONFIG does not bind orbit-staging" >&2; exit 1
fi
if grep -q '2b83f719-4207-496e-baa9-491e9f2af257' "$CONFIG"; then
  echo "REFUSING: $CONFIG contains the production database id" >&2; exit 1
fi
echo "Resetting $DB (staging)..."
npx wrangler d1 execute "$DB" --remote --file=scripts/staging-seed.sql
npx wrangler d1 execute "$DB" --remote --file=scripts/staging-seed-extra.sql
echo "Seed complete."
