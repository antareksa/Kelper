# Feature: Weekly Per-Item GMS ROAS Auto-Adjust

**Status:** Planning only — nothing built yet. This doc captures what's been researched and decided so far, and what's still open before implementation can start.

## Client requirement (as given)

> Every week we check: if this week's Laba > last week's Laba + x%, decrease target ROAS by y. Else if this week's Laba < last week's Laba + x%, increase target ROAS by y. Else keep it.

Clarified scope, from discussion:
- **Per item**, not shop-wide — each managed SKU is evaluated and adjusted independently.
- Laba basis: the Dashboard's own per-item Laba (from KELPER's own order/price/HPP data, not Shopee's), same number already shown elsewhere (e.g. the "Price Diff / HPP Diff" section, `topProducts`).
- **Edit only — never create.** The automation must never call Shopee's campaign-creation endpoint. It only adjusts the `roas_target` of a campaign that already exists for that item.

## Resolved: the item↔campaign mapping gap is closed

Earlier research into `create`/`edit`/`edit_item`/`get_product_level_campaign_id_list` found no way to ask Shopee "does item X already have a campaign, and what's its current ROAS target" — that looked like a hard blocker requiring a manually-seeded SKU → campaign_id list. **Two more endpoints close this gap completely:**

| Endpoint | What it does | Item ↔ campaign mapping? | Current ROAS target? |
|---|---|---|---|
| `v2.ads.create_gms_product_campaign` | Creates a new campaign | N/A (not used — edit only) | N/A |
| `v2.ads.edit_gms_item_product_campaign` | Add/remove items in a campaign (write-only) | No — no read equivalent | No |
| `v2.ads.edit_gms_product_campaign` | Change budget/duration/pause/resume/start/ROAS target of a campaign | No | No (write-only) |
| `v2.ads.get_product_level_campaign_id_list` | Lists every `campaign_id` for the shop, with `ad_type` (auto/manual), paginated | No — shop-wide ID list only | No |
| `v2.ads.get_product_campaign_daily_performance` | Per-campaign daily ad performance (impressions, clicks, expense, GMV, ROAS/ACOS, conversions — both "broad" and "direct") for up to 100 campaign IDs, max 1-month range, data retained ~6 months | No | No — this is performance, not settings |
| **`v2.ads.get_product_level_campaign_setting_info`** | Fetches full settings for up to 100 campaign IDs — `common_info` (status, budget, duration, **`item_id_list`**), `manual_bidding_info`, and **`auto_bidding_info.roas_target`** | **Yes — `item_id_list` per campaign** | **Yes — `auto_bidding_info.roas_target`** |

All six require app type **Seller In House System / Ads Service / Ads Service App** (or **Marketing** / **Ads Facil** for the two newest ones) — KELPER's main app already qualifies, no new credentials needed.

**Consequence:** no manual seed list is required. The full item↔campaign↔current-ROAS-target picture can be rebuilt from the API at any time:

```
1. get_product_level_campaign_id_list  -> every campaign_id for the shop (paginated)
2. get_product_level_campaign_setting_info(campaign_id_list, info_type_list=[1,3])
     -> for each campaign: item_id_list, campaign_status, auto_bidding_info.roas_target
3. Flatten into sku/item_id -> campaign_id -> current roas_target
```
(batched in groups of ≤100 campaign IDs per call, per both endpoints' limits)

KELPER can still choose to cache this mapping locally for speed, but it's a convenience now, not a dependency — it can always be rebuilt from Shopee directly, and will self-correct if a campaign is ever touched outside KELPER.

## One real constraint this surfaces: manual vs. auto product selection

`common_info.item_id_list`'s own description: *"If the campaign is using auto product selection it can have between zero and many products. If the campaign is using manual product selection, it has exactly one."*

So not every campaign is naturally a clean 1-item-per-campaign fit:
- **Manual product selection** (`item_id_list` has exactly 1 item) — maps cleanly to "each per item," safe to manage individually.
- **Auto product selection** (`item_id_list` can have 0 to many items) — a campaign like this could cover several items at once; adjusting its `roas_target` for "item X's" weekly Laba would also move every other item sharing that campaign.

**Before building:** campaigns discovered via the sync above should be filtered to only the ones with exactly 1 item in `item_id_list` (or otherwise confirmed single-item/manual) — multi-item campaigns need to be explicitly excluded from this automation, or handled with different logic entirely (e.g. aggregate Laba across all items sharing that campaign).

## Weekly rule (pseudocode)

```
for each managed SKU, discovered via the sync above (sku, campaign_id, current_roas_target):
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
```

`current_roas_target` is read directly from Shopee (`get_product_level_campaign_setting_info`) immediately before each weekly adjustment, not from a locally-cached value — avoids any drift if a campaign was ever touched outside KELPER.

## Open questions (must be settled before building)

1. **Floor/ceiling values.** Stated as "Floor 10, ceil 1" — this is floor > ceiling, backwards from the normal meaning (floor = lower bound, ceiling = upper bound). Needs clarifying: is it floor 1 / ceiling 10, or something else entirely?
2. **Direction of adjustment.** As written, a *good* week (profit beat last week by x%) *decreases* the ROAS target — which in Shopee's GMV Max Custom ROAS model means bidding *more* aggressively (spend more, lower required return per ad-rupiah). A *bad* week *increases* it (more conservative, likely less spend). This is a legitimate "double down on what's working" strategy, but it's worth one explicit confirmation since it's the opposite of an instinctive "profit's down, cut ad spend" read — and it's real money being moved automatically.
3. **x and y values** — not yet specified (presumably configurable, not hardcoded).
4. **Week boundary** — which day does the week start on (WIB)? Needs to match whatever cadence the client thinks in.
5. **What happens on a week with no prior week's data yet** (first week for a newly-added SKU) — skip, or treat as "no change"?
6. **Multi-item (auto product selection) campaigns** — confirm these should simply be excluded from the automation, per the constraint above, rather than handled some other way.

## Implementation needs (once the above is settled)

- A new weekly rollup of Laba per-SKU (the daily numbers already exist; this is a new aggregation only).
- A local settings surface for `x`, `y`, `floor`, `ceiling`.
- A new scheduled job — nothing in KELPER currently runs on anything but the existing 5-second sync loop or manual SSH scripts; a weekly trigger is new infrastructure.
- The campaign discovery sync (`get_product_level_campaign_id_list` + `get_product_level_campaign_setting_info`) and the actual adjustment call (`edit_gms_product_campaign`, `change_roas_target`) — both confirmed working per the docs.
