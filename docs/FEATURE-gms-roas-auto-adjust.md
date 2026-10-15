# Feature: Weekly Per-Item GMS ROAS Auto-Adjust

**Status:** Planning only — nothing built yet. All decisions settled 2026-10-15 (see *Settled*). This doc captures what's been researched and decided so far, and what's still open before implementation can start.

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

Runs every **Monday 00:05 WIB**. "This week" = the Monday-Sunday that just ended,
"last week" = the Monday-Sunday before it (both full, closed weeks).

```
for each campaign (from the sync above) with exactly 1 item in item_id_list:
  item            = that item_id (all its models/SKUs together; a bundle listing is its own item)
  current_target  = auto_bidding_info.roas_target, read from Shopee just now

  this_week  = item Laba (Dashboard basis) - campaign expense   over this week
  last_week  = item Laba (Dashboard basis) - campaign expense   over last week
  (expense from get_product_campaign_daily_performance)

  if last week has no data:              skip (log "tidak ada data minggu lalu")
  change = (this_week - last_week) / |last_week| * 100

  if change >  +10%:   new_target = current_target - 0.5   # good week: spend more
  elif change < -10%:  new_target = current_target + 0.5   # bad week: spend less
  else:                skip (within +/-10%)

  new_target = clamp(new_target, 1, 10)
  if new_target != current_target:
      edit_gms_product_campaign(campaign_id, edit_action=change_roas_target, roas_target=new_target)
  log every decision (changed or skipped, with the numbers) for the Dashboard
```

Campaigns with 0 or more than 1 item (auto product selection) are **skipped** and
shown as "dilewati: lebih dari 1 produk".

## Settled (2026-10-15)

- **Direction:** confirmed by the client - it is meant to balance: Laba up -> lower the
  target (spend more), Laba down -> raise it (spend less).
- **Laba basis:** item Laba **minus that campaign's ad spend**. Plain Laba ignores ad
  cost, so with growing sales it would only ever lower the target down to the floor
  while real profit turns into a loss.
- **Band (x):** 10%. More than +10% -> lower, more than -10% -> raise, otherwise no change.
- **Step (y):** 0.5 (e.g. 4.5 -> 5.0).
- **Floor / ceiling:** 1 / 10.
- **Schedule:** Monday 00:05 WIB, comparing the two full weeks before it (a run at
  23:59 Sunday would miss late pickups and late ad data).
- **No data for last week:** skip that item.
- **Multi-item campaigns:** skip for now.
- **Proteksi ROAS:** the user confirmed weekly target changes are safe for it. The
  ROAS-protection rebate is NOT added back into the Laba figure (assumption; revisit if
  the client wants it).

## Open questions

None blocking. x, y, floor and ceiling should still be settings, not hard-coded.

## Implementation needs (once the above is settled)

- A new weekly rollup of Laba per-SKU (the daily numbers already exist; this is a new aggregation only).
- A local settings surface for `x` (10), `y` (0.5), `floor` (1), `ceiling` (10), plus an on/off switch.
- A Dashboard list: item | campaign | current target | last decision (changed / skipped + why) | status, and a log of every change.
- Item Laba per Shopee `item_id` (sum over its models' SKUs) - today Laba is per SKU.
- A new scheduled job — nothing in KELPER currently runs on anything but the existing 5-second sync loop or manual SSH scripts; a weekly trigger is new infrastructure.
- The campaign discovery sync (`get_product_level_campaign_id_list` + `get_product_level_campaign_setting_info`) and the actual adjustment call (`edit_gms_product_campaign`, `change_roas_target`) — both confirmed working per the docs.
