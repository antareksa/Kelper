# Feature: TikTok Shop Integration

**Status:** Planning only — nothing built yet. Two draft deploy files exist locally, uncommitted, not referenced by anything live: `deploy/kelper-staging.service`, `deploy/setup-staging.sh`. This doc is what gets reviewed/approved before either is pushed or any application code is written.

## Client requirement (as given)

> Implement TikTok orders into the app, the same way Shopee orders are handled — one app, handling orders from both the Shopee shop and the TikTok shop together (confirmed: unified, not two separate systems).

## The constraint that shapes everything below

KELPER is **live in production right now**, actively used by the client to pack and ship real Shopee orders every day. Nothing about building TikTok support may touch that — not the real database, not the real Packing Station queue staff are working from, not the real Shopee credentials/tokens. This is the reason every piece of the plan below is additive/parallel rather than modifying existing code in place.

## Part 1 — A separate staging environment (build/test TikTok here, not on production)

TikTok's OAuth connect flow and (likely) webhooks need a real, publicly reachable HTTPS domain — a local dev machine or this cloud session can't receive those callbacks. So testing has to happen on a VM, the same way Shopee's own sandbox→live testing originally did (`deploy/SSH-CHEATSHEET.md`'s "Switch both Shopee apps from sandbox to LIVE" section). But testing on the **real** production VM/database risks TikTok sandbox test orders showing up in the real, staff-facing Packing Station queue — unacceptable given the app is actively in use.

**Decision: a second, fully separate deployment ("staging"), not a mode flag on the existing one.**

- Separate directory on the VM: `/opt/kelper-staging` (a second `git clone` of this same repo), not a switch inside `/opt/kelper`.
- Separate systemd service: `kelper-staging` (new, alongside the existing `kelper` service — doesn't touch it), listening on **port 3002** (the app already supports `PORT` as an env var; 3001 stays the real one).
- Separate database: happens automatically — `db.js` opens `kelper.${NODE_ENV}.db` relative to wherever the app is running from, so a second checkout directory gets its own separate SQLite file with zero code changes.
- Separate config/credentials: its own `.env.production` (written by `setup-staging.sh`: a staging admin login only, later TikTok **sandbox** credentials; never real Shopee or live TikTok keys). `config.production.json` is shared through git, so anything that must differ goes in a gitignored `kelper-backend/config.local.json` (also written by the setup script): `instanceName: "staging"` (backup.js then uses the `kelper-staging` service and `backups/staging/`, never production's backup folder) and `evidence.gcsEnabled: false` (no uploads into the real video bucket).
- Runs with `NODE_ENV=production` (not `development`) — this project's `env.js` only recognizes those two values, and staging should behave exactly like production code-wise. The isolation comes entirely from being a different directory/service/port, not from a different `NODE_ENV` string.
- Separate domains, same split as production: `dashboard.staging.kelper.co.id` and `packing.staging.kelper.co.id` (App.jsx picks the view from the `dashboard`/`packing` hostname prefix), proxied by the VM's existing Caddy to `localhost:3002`. Added with `deploy/add-staging-https.sh`, which only **appends** one block (backup first, validate, restore the backup on failure, `reload` not `restart`). Never use `deploy/setup-https.sh` for this: it overwrites the whole Caddyfile and would drop the live `dashboard.kelper.co.id`/`packing.kelper.co.id` sites.

**Files status (2026-11-02):** `deploy/kelper-staging.service`, `deploy/setup-staging.sh` (refuses to run from `/opt/kelper`, refuses if port 3002 is taken by something else) and `deploy/add-staging-https.sh` are all written; not yet run on the VM.

**Blocked on (only the user can provide):**
- DNS A records for `dashboard.staging.kelper.co.id` and `packing.staging.kelper.co.id` pointed at the VM.

## Part 2 — Application architecture for the TikTok integration itself

Not started. Planned shape, so Shopee code paths are never touched:

- **New `kelper-backend/src/tiktok/` folder**, mirroring `src/shopee/` (client, auth, shipping) — no shared code with Shopee's modules at first.
- **New `platform` column** on `orders` (and anywhere else it matters), `ALTER TABLE ... ADD COLUMN platform TEXT NOT NULL DEFAULT 'shopee'` — the same non-destructive migration pattern used everywhere else in `db.js`. Every existing row/query that doesn't know about `platform` keeps working unchanged.
- **Orders keyed by `(platform, shop_id)`**, not `shop_id` alone — Shopee and TikTok shop IDs are separate namespaces and could collide.
- **New, independent `tiktokSync.js`** sync loop, separate from `shopeeSync.js`'s `discoveryLoop`/`enrichmentLoop` — a TikTok-side bug or outage can't affect Shopee sync, and vice versa.
- **A `tiktokEnabled` setting, default OFF** (or simply: no TikTok app connected yet) — so this code can be merged to `main` and deployed to the real production VM at any point during development with zero behavior change, same principle as every other new setting this session (always defaults to "preserve current behavior").
- **Packing Station / Dashboard generalization — the genuinely open part.** `resolveOrderBucket`, priority ordering, and the Omzet/Laba math all currently assume Shopee-shaped data (logistics channels, escrow/income fields, Shopee's own order status values). Before touching any of that code, we need TikTok Shop's actual order/shipping/financial model — which requires TikTok Shop Partner Center access and their API docs. Unknown right now, not guessed at.

**Blocked on (only the user can provide):**
- TikTok Shop Partner Center account + app registration (sandbox App Key/Secret) — TikTok's equivalent of Shopee's Open Platform signup.
- TikTok Shop API documentation, once available, to confirm: their OAuth flow shape, order status values, whether an "instant delivery" concept exists, their equivalent of escrow/order income, their shipping/label model.

## Open questions (must be settled before Part 2 can really start)

1. Does the client want a Shopee **sandbox** shop connected on staging too (to test the "two marketplaces unified" scenario end-to-end), or is TikTok-only testing sufficient for now?
2. Once TikTok's order/shipping model is known: does it map cleanly onto the existing Packing Station bucket states (Waiting List / Processing / Ready to Check / etc.), or does it need its own parallel bucket logic?
3. Dashboard numbers (Omzet, Laba, etc.) — combined total across both marketplaces, or kept separately filterable? Affects `routes/dashboard.js`'s queries, which currently assume one shop per calculation.
4. Timeline/priority — is this meant to go live this quarter, or is it fine to build incrementally alongside other work?

## Next step

Once this doc is reviewed: commit + push the two staging deploy files, write the additive Caddy script, and the user sets up the DNS record — all before any TikTok application code is written.
