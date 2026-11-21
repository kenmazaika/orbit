# Orbit object model — phase 1

Status: **Artifacts and Inbox run on `obj_*` in production.** The Worker uses the shared D1 binding.
The generic bridge consumes `obj_agent_actions` through `/api/v1/agent/actions`.

## Baseline before migration

One Cloudflare Worker (`worker/index.js`) serves a password gate, a static Astro build inlined as
`worker/assets.generated.js`, two JSON APIs, and two runtime surfaces (Inbox, Artifacts).

- **Cloudflare KV** — none. The earlier inbox POC used KV; it was replaced by D1 because list propagation
  made delivery slow. No `kv_namespaces` exists in `wrangler.json`.
- **Cloudflare Functions** — none. All dynamic behavior is route branches inside the single Worker.
- **Astro** — build-time only. Pages read content collections and emit static HTML; the Worker serves those
  bytes. No SSR adapter, no runtime content reads.
- **Markdown publishing** — notes and reports are files in `src/content/{notes,reports}`. The files are the
  source of truth; git is the history; the build is the projection.
- **Inbox** — vault markdown is the source of truth. `bin/orbit-inbox-sync.mjs` scans folders 00.01–00.04,
  assigns stable `orbit_id`s (`state/orbit-inbox-ids.json`), and POSTs a projection into D1 `cards`.
  Decisions flow back as D1 `actions`; `bin/orbit_apply.py` (via `inboxctl apply`) flips the checkbox in the
  original note, and the local ledger (`state/inbox-ledger.json`) remains the agent-side durability layer.
- **Artifacts** — D1 is the source of truth. `poc_articles`, `poc_revisions`, `poc_events`, `poc_requests`,
  `poc_images`. A local bridge claims requests, runs an agent, and posts a new revision.
- **Reports** — generated markdown files, deployed by cron; no database.

## Data inventory

| Data | Source of truth | Written by | Read by | Contract |
| --- | --- | --- | --- | --- |
| Notes | `src/content/notes/*.md` (git) | humans, agents, `orbit-publish.sh` | Astro build, `/notes.json` | slug = filename |
| Reports | `src/content/reports/*.md` (git) | daily-report cron | Astro build | `/report/<date>/` |
| Inbox cards | vault notes 00.01–00.04 | `orbit-inbox-sync.mjs` → D1 `cards` | `/api/orbit-inbox/cards` | `orbit_id` in frontmatter + id map |
| Inbox decisions | D1 `actions` | Inbox UI | sync bridge → `inboxctl apply` | `{orbit_id, actions[], instruction}` |
| Inbox ledger | `state/inbox-ledger.json` | `inbox_core.py` | sweep / agent | local only |
| Artifacts | D1 `poc_*` | seed, UI feedback, bridge | `/api/lab/artifact/*` | article id, V-number |
| Sessions | none (HMAC cookie) | Worker | Worker | 30-day cookie |
| Read/saved state | browser localStorage | client | client | no server store |

IDs and URLs that must survive: 16-hex `orbit_id`; artifact ids (`obsidian-value`); note slugs;
`/`, `/inbox/`, `/artifacts/…`, `/report/…`, `/notes/…`; the five inbox endpoints and the artifact
queue/claim/progress/result endpoints.

## Proposed schema (D1, additive `obj_*`)

- `obj_workspaces` — tenancy root.
- `obj_objects` — one row per entity; `kind` is the discriminator; `external_id` preserves legacy ids;
  unique `(workspace_id, kind, external_id)`.
- `obj_revisions` — numbered, content-addressed; unique `(object_id, number)`.
- `obj_relationships` — typed directed edges; unique `(from, to, relation)`, indexed both ways.
- `obj_events` — append-only audit log, not a queue.
- `obj_agent_actions` — durable agent work items with idempotency keys (generalizes `poc_requests`).
- `obj_meta` — schema version.

No foreign keys in phase 1 (connection-scoped in SQLite/D1; adds failure modes during staged migration).

## Feature-level storage switching

`worker/objects/flags.js` resolves `ORBIT_STORAGE_<FEATURE>` to `legacy | shadow | objects`.

- Default is always `legacy`.
- Unknown values, unknown features, or a missing `ORBIT_OBJECTS_DB` binding fall back to `legacy`.
- It never throws.
- It is **not imported** by the worker; a guard test fails if that changes.

## Migration sequence (each step independently deployable and reversible)

1. **Foundation (next).** Create the D1 database, add a staging-only binding, apply `0001`, run the tests.
   Production binding unchanged; worker unchanged.
2. **Shadow import, artifacts.** A one-shot script writes artifacts into `obj_*` and records the source
   hash. No reads. Verify counts and hashes. Reversible by dropping the rows (not the tables).
3. **Dual-read artifacts.** Read `obj_*` behind `ORBIT_STORAGE_ARTIFACTS=shadow`, compare to `poc_*`, log
   drift, still serve `poc_*`. No writes.
4. **Cut over artifacts reads.** Flip to `objects`, keep `poc_*` writes. Reversible by one flag.
5. **Cut over artifacts writes.** Write revisions to `obj_revisions`, keep `poc_*` mirrored for one cycle.
6. **Inbox.** Repeat 2–5 for `cards` as a projection with `external_id = orbit_id`; the vault stays
   authoritative.
7. **Notes/reports.** Optional: project published markdown into `objects` for cross-linking; Astro remains
   the renderer.

Each step ends with a verification receipt (counts, hashes, route checks) and a named rollback.

## Risks

- **Two writers during cutover.** Mitigation: one authority per step; the flag only changes reads first.
- **ID drift.** Mitigation: `external_id` is written once and never regenerated; tests assert uniqueness.
- **D1 latency on hot reads.** Mitigation: unchanged routes keep serving from current storage until measured.
- **Event log growth.** Mitigation: append-only with indexes; no UI reads the full log in phase 1.
- **Silent coupling.** Mitigation: the production-guard test fails if the worker imports the object layer or
  the config gains the binding without an explicit commit.

## Rollback

- Local: `scripts/objects-rollback.sh` (dry run) → `--yes-drop`.
- Remote: `scripts/objects-rollback.sh --remote --yes-remote --yes-drop`.
- Drops only `obj_*`. Never touches `cards`, `actions`, `events`, or `poc_*`.
- Because phase 1 has no runtime dependency, the emergency rollback is simply: do not deploy, or revert the
  three commits. Production behavior is unchanged either way.

## Tests

```bash
npm run test:objects
```

- `flags.test.mjs` — default, fallbacks, hostile env, naming.
- `schema.test.mjs` — applies `0001` to an in-memory SQLite DB, asserts tables, uniqueness, idempotency,
  and that the migration contains no destructive statement.
- `production-guards.test.mjs` — production config has no objects binding; the worker does not import the
  object layer; existing routes/contracts still present; rollback only names `obj_*`.

## Artifacts migration (0002)

Schema: `migrations/objects/0002_artifacts.sql` adds current-revision pointers, legacy ids, action leases,
`obj_assets` (images), and `obj_api_tokens` (sha256-hashed agent tokens). Additive only.

Mapping: artifact id = `poc_articles.id`; revision id = `poc_revisions.id` (numbers preserved); request id =
`poc_requests.id`; message id = `poc_events.id`; image id = `poc_images.id`. Kinds: `orbit.artifact`,
`orbit.feedback`, `orbit.message`.

API v1: `/api/v1/artifacts`, `/api/v1/artifacts/:id`, `.../revisions`, `.../feedback`, `.../close`,
`.../images`, `/api/v1/revisions/:id`, `/api/v1/images/:id`; generic `/api/v1/objects[...]`; agent
`/api/v1/agent/actions[...]`; migration `/api/v1/migrate/{artifacts,reconcile,export-legacy}`.

While `ORBIT_STORAGE_ARTIFACTS` is `legacy` (default), v1 artifact routes delegate to the existing
`/api/lab/artifact` handler, so the UI and bridge keep their current behavior. When it flips to `objects`,
the same URLs are served by the service layer over `obj_*`.

```bash
# local backfill + reconcile (against a migrated local D1)
node --test tests/objects/*.test.mjs
# once deployed, agent-only:
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/v1/migrate/artifacts
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/v1/migrate/reconcile
```

## Inbox migration (0003)

- **Kinds:** `orbit.inbox` for information and `orbit.decision` for actionable choices.
- **API:** `/api/v1/inbox` plus `/:id`, `/selections`, `/submit`, `/dismiss`, and `/close`.
- **Submission:** one `inbox.decision` action per object. Repeated submits return the same action.
- **Backfill:** `/api/v1/migrate/inbox` imports open `cards` only. It creates no actions.
- **Reconcile:** `/api/v1/migrate/inbox/reconcile` compares legacy IDs, titles, and source hashes.
- **UI:** `/inbox/` reads and writes `/api/v1/inbox`; polling remains client-side at two seconds.
- **Bridge:** `bin/orbit-bridge.mjs` handles artifact feedback/workflows and Inbox decisions.

Production cutover: 2026-11-14. Seven open cards imported; zero historical actions created; reconcile passed.
