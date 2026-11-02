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
- Separate config/credentials: same mechanism — its own `.env.production` and `config.production.json`, physically in the staging directory, holding **TikTok sandbox credentials only** (no real Shopee, no real TikTok-live credentials ever go in this file).
- Runs with `NODE_ENV=production` (not `development`) — this project's `env.js` only recognizes those two values, and staging should behave exactly like production code-wise. The isolation comes entirely from being a different directory/service/port, not from a different `NODE_ENV` string.
- Separate domain: `staging.kelper.co.id`, proxied by the VM's existing Caddy reverse proxy to `localhost:3002`. **Caveat already identified:** the existing `deploy/setup-https.sh` *overwrites* the whole Caddyfile rather than adding to it — re-running it naively for just the staging domain would wipe out the live `dashboard.kelper.co.id`/`packing.kelper.co.id` entries and break HTTPS for the real app. A separate, additive-only script is needed for this step (not yet written).

**Draft files status:**
- `deploy/kelper-staging.service` — written, matches `deploy/kelper.service`'s shape, port 3002. Not committed.
- `deploy/setup-staging.sh` — written, matches `deploy/setup-vm.sh`'s shape; refuses to run if `APP_DIR` resolves to `/opt/kelper` (the real prod path), as a hard guard against misconfiguration. Not committed.
- Still needed: the additive Caddy script for `staging.kelper.co.id`.

**Blocked on (only the user can provide):**
- A `staging.kelper.co.id` DNS record pointed at the VM (or a decision to use a second VM instead of sharing the existing one).
- Confirmation that port 3002 is actually free on the VM.
- A fresh admin account created on the staging instance once it's up (its database starts completely empty — no data copied from production).

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
