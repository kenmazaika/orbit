# Orbit

Orbit is a self-hosted workspace for agent-assisted work: artifacts, inbox decisions, work threads, and a
React frontend backed by a Cloudflare Worker and D1.

This repository is the **authoritative source** for the shared product and the self-hosted edition. The hosted
edition (Orbit Cloud) lives in a separate private repository and consumes this repository as a Git submodule.

## Requirements

- Node.js 22.12+
- npm
- A Cloudflare account (for deployment; not required to build)

## Install and build

```bash
npm install
npm --prefix react install
npm run build:selfhosted     # content + React bundle + worker asset module
npm run test:objects         # shared object API test suite
```

Build output: `react/dist` and `worker/react-prod-assets.generated.js`.

## Deploy (self-hosted)

1. Copy the Wrangler config and replace the placeholder D1 id:
   - `wrangler.react-prod.json` (worker `orbit`, binding `ORBIT_OBJECTS_DB` / `ORBIT_INBOX_DB`)
2. Create the D1 database and apply the schema:
   ```bash
   npx wrangler d1 create orbit
   npx wrangler d1 execute orbit --remote --file=schema.sql
   for f in migrations/objects/0001*.sql migrations/objects/0002*.sql \
            migrations/objects/0003*.sql migrations/objects/0004*.sql \
            migrations/objects/0005*.sql migrations/objects/0006*.sql \
            migrations/objects/0007*.sql; do
     npx wrangler d1 execute orbit --remote --file="$f"
   done
   ```
3. Set the password secret and build/deploy:
   ```bash
   npx wrangler secret put ORBIT_PASSWORD --config wrangler.react-prod.json
   npm run build:selfhosted
   npx wrangler deploy --config wrangler.react-prod.json
   ```

## Layout

- `react/src` — shared React frontend
- `worker/objects` — shared object API, work, inbox, artifacts
- `worker/react-prod.js` — self-hosted Worker shell (password gate)
- `worker/index.js` — legacy Astro Worker shell
- `migrations/objects/0001–0007` — shared schema
- `tests/objects` — shared API tests

Cloud-only code, hosted auth, multi-tenancy, and cloud migrations are **not** in this repository.

## License

MIT — see `LICENSE`.
