# Feature: Weekly Per-Item GMS ROAS Auto-Adjust

**Status:** Planning only — nothing built yet. This doc captures what's been researched and decided so far, and what's still open before implementation can start.

## Client requirement (as given)

> Every week we check: if this week's Laba > last week's Laba + x%, decrease target ROAS by y. Else if this week's Laba < last week's Laba + x%, increase target ROAS by y. Else keep it.

Clarified scope, from discussion:
- **Per item**, not shop-wide — each managed SKU is evaluated and adjusted independently.
- Laba basis: the Dashboard's own per-item Laba (from KELPER's own order/price/HPP data, not Shopee's), same number already shown elsewhere (e.g. the "Price Diff / HPP Diff" section, `topProducts`).
- **Edit only — never create.** The automation must never call Shopee's campaign-creation endpoint. It only adjusts the `roas_target` of a campaign that already exists for that item.

## Why "edit only" matters

Shopee's Ads API has no endpoint that answers "does item X already have a campaign, and if so, which one and what's its current ROAS target." Three of the related endpoints were checked:

| Endpoint | What it does | Does it map item → campaign? |
|---|---|---|
| `v2.ads.create_gms_product_campaign` | Creates a new campaign | N/A (not used by this feature) |
| `v2.ads.edit_gms_item_product_campaign` | Add/remove items in a campaign (write-only) | No — no read equivalent |
| `v2.ads.edit_gms_product_campaign` | Change budget/duration/pause/resume/start/ROAS target of a campaign | No |
| `v2.ads.get_product_level_campaign_id_list` | Lists every campaign_id for the shop, with `ad_type` (auto/manual) | No — shop-wide list only, not which items are in each one |

All four require app type **Seller In House System / Ads Service / Ads Service App** — KELPER's main app already qualifies, no new credentials needed.

**Consequence:** since we're not creating campaigns, and Shopee can't tell us which campaign an item already belongs to, **KELPER must be handed the SKU → campaign_id mapping up front** and keep it in its own records. There is no way to discover this mapping automatically.

## Required seed data (blocking)

A list of, for every SKU this feature should manage:
- `sku`
- `campaign_id` (the existing GMS campaign already running for that item)

This has to come from the client or wherever these campaigns were originally set up — KELPER has no way to derive it from the API.

## Weekly rule (pseudocode)

```
for each managed SKU (sku, campaign_id) in the seed list:
  this_week_laba  = sum of per-item Laba, last 7 days
  last_week_laba  = sum of per-item Laba, the 7 days before that
  threshold       = last_week_laba * (1 + x / 100)

  if this_week_laba > threshold:
      new_target = current_roas_target - y   # "decrease" = more aggressive bidding
  elif this_week_laba < threshold:
      new_target = current_roas_target + y   # "increase" = more conservative bidding
  else:
      new_target = current_roas_target        # unchanged

  new_target = clamp(new_target, floor, ceiling)

  if new_target != current_roas_target:
      call edit_gms_product_campaign(campaign_id, edit_action=change_roas_target, roas_target=new_target)
      store new_target locally for this sku
```

`current_roas_target` is read from KELPER's own stored record (set at seed time, updated after every successful edit) — never from Shopee, since there's no endpoint to read it back.

## Open questions (must be settled before building)

1. **Floor/ceiling values.** Stated as "Floor 10, ceil 1" — this is floor > ceiling, backwards from the normal meaning (floor = lower bound, ceiling = upper bound). Needs clarifying: is it floor 1 / ceiling 10, or something else entirely?
2. **Direction of adjustment.** As written, a *good* week (profit beat last week by x%) *decreases* the ROAS target — which in Shopee's GMV Max Custom ROAS model means bidding *more* aggressively (spend more, lower required return per ad-rupiah). A *bad* week *increases* it (more conservative, likely less spend). This is a legitimate "double down on what's working" strategy, but it's worth one explicit confirmation since it's the opposite of an instinctive "profit's down, cut ad spend" read — and it's real money being moved automatically.
3. **The SKU → campaign_id seed list itself** — not yet provided.
4. **x and y values** — not yet specified (presumably configurable, not hardcoded).
5. **Week boundary** — which day does the week start on (WIB)? Needs to match whatever cadence the client thinks in.
6. **What happens on a week with no prior week's data** (first week for a newly-added SKU) — skip, or treat as "no change"?

## Implementation needs (once the above is settled)

- A new weekly rollup of Laba per-SKU (the daily numbers already exist; this is a new aggregation only).
- A local settings surface for `x`, `y`, `floor`, `ceiling`, and the SKU → campaign_id → current roas_target records.
- A new scheduled job — nothing in KELPER currently runs on anything but the existing 5-second sync loop or manual SSH scripts; a weekly trigger is new infrastructure.
- The actual Shopee API call (`edit_gms_product_campaign`, `change_roas_target`) — already confirmed working per the docs.

## Not yet investigated

`v2.ads.get_product_campaign_daily_performance` — referenced in every GMS doc's sidebar but not yet read. If its response breaks spend/performance down by `item_id` within a campaign, it could partially close the item→campaign mapping gap (anything with reported performance under campaign Y is in campaign Y) — worth getting this doc before committing to the manual-seed-only approach as permanent.
