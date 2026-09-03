# Workflows

Multi-step recipes. Verify every step's billing in CLI discovery. State free steps as zero cost,
and obtain agreement for every non-free step and for the workflow total before starting it.

## Category to product, without guessing an ID

A category name is not a NodeId. Resolve it first.

```bash
# 5 requests. Measured live on US: 6m33s, 10.4 MB, 35,126 nodes.
# Always write it to a file, and tell the user it will take several minutes.
sorftime-team -d us category tree --output-file /tmp/us-category-tree.json
```

Then search that file locally for the leaf node. Local reads are free; re-fetching the tree is not.
Once you have the NodeId:

```bash
sorftime-team -d us category best-sellers --node-id 11139610011   # 5 requests, Top 100
```

## Best Sellers over a date range

`--query-start` plus `--query-date` switches to historical mode, billed **10 requests per 3-day
block, rounded up**. Compute the cost before running and say it out loud:

- 6 days = 2 blocks = 20 requests
- 30 days = 10 blocks = 100 requests
- 40 days (the documented maximum span) = 14 blocks = 140 requests

```bash
sorftime-team -d us category best-sellers --node-id 11139610011 \
  --query-start 2026-08-01 --query-date 2026-08-07
```

Two traps in the historical response:

- rows are merged and de-duplicated by `ParentAsin`, so it is not a per-day list;
- the sales figure is the **final day's rolling 30-day sales**, not the range total. Never present
  it as "units sold during this period".

The latest supported date is today minus 2 days.

## Product detail and daily trends

```bash
sorftime-team -d us product get --asin B0XXXXXXXX             # 1 request
sorftime-team -d us product get --asin B0XXXXXXXX --trend 1 \
  --query-trend-start-dt 2026-07-01 --query-trend-end-dt 2026-08-31   # 2 requests, span > 15 days
```

`--asin` is variadic and accepts up to 10 ASINs, billed per ASIN. Trend arrays usually interleave
date and value (`[20260319, 9, 20260320, 11, ...]`), but some responses return a bare value array
with no dates. Detect the shape per response; do not assume one format. Monetary values are in the
marketplace's smallest currency unit - `2699` is 26.99, not 2699.

A nonexistent or delisted ASIN can still consume quota.

## Asynchronous flows

Three flows are start-poll-fetch. Poll manually with the user's agreement; never loop automatically.

**Realtime product refresh** - forces a fresh crawl rather than reusing cached data:

```bash
sorftime-team -d us product realtime-start --asin B0XXXXXXXX --update 24   # 1 request (JP 2)
sorftime-team -d us product realtime-status --query-date 2026-09-01        # 1 request
sorftime-team -d us product get --asin B0XXXXXXXX                          # 1 request
```

**Image similarity search** - roughly 5 minutes, expect 20+ results:

```bash
sorftime-team -d us product similar-start --image @/path/to/photo.jpg   # 5 requests (JP 6)
sorftime-team -d us product similar-status                              # free
sorftime-team -d us product similar-results --task-id <id>              # free
```

**Sorftime Agent** - 25 requests per report. Prefer reading the underlying data yourself:

```bash
sorftime-team -d us agent product --asin B0XXXXXXXX --type 0   # 25 requests
sorftime-team -d us agent status --method 0 \
  --query-start 2026-08-28 --query-end 2026-09-03         # 1 request
sorftime-team -d us agent result --task-id <id>                # free
```

`realtime-start`, `similar-start`, and the two `agent` starters create server-side tasks. Retrying
them duplicates the work and the charge, which is why `--retries` needs `--retry-unsafe`. Do not
pass it.

## Reading existing monitors

Creating monitors is blocked, but reading whatever already exists is free.

```bash
sorftime-team -d us monitor best-seller-list                    # what is subscribed
sorftime-team -d us monitor best-seller-data --node-id 11139610011 \
  --best-seller-list-type 5 --query-date "2026-09-01 06"   # one window
```

`--best-seller-list-type` is `1` New Releases, `3` Most Wished For, `4` Gift Ideas, `5` Best
Sellers. A daily monitor returns the 6-hour window after the requested hour; a 12-per-day monitor
returns a 2-hour window.

An empty result means no monitor covers that node/type/hour. Say that, rather than reporting no
activity. Monitoring data is documented as retained about 30 days.

## Reviews

`product reviews-collect` is blocked, so only previously collected reviews are readable:

```bash
sorftime-team -d us product reviews-status --asin B0XXXXXXXX   # free, is anything collected?
sorftime-team -d us product reviews-list --asin B0XXXXXXXX --star 10   # 5 requests
```

`--star` accepts `1`-`5`, `10` for negative (1-3 stars), `11` for positive (4-5 stars).
If `reviews-status` shows nothing collected, report that collection is unavailable under the
Coin block instead of returning an empty list as if the product had no reviews.

For the star distribution alone, `product get` already returns 1-5 star percentages for 1 request -
much cheaper than the review endpoints.

## Keywords: find real ABA terms first

Every keyword endpoint accepts Amazon Brand Analytics terms only. A plausible-sounding phrase you
invented will return `code 11`, which means "not an ABA keyword", not "no search volume".

Start from a real ASIN or category rather than a guess:

```bash
sorftime-team -d us keyword by-asin --asin B0XXXXXXXX --page-size 20        # 1 request
sorftime-team -d us keyword by-category --node-id 11139610011 --page-size 20 # 1 request
```

Then feed a returned term into the detail endpoints:

```bash
sorftime-team -d us keyword get --keyword "mini tripod iphone"   # 1 request
```

Three parameters the source documentation marks optional are rejected without (verified live
2026-09-03); the CLI now fails locally rather than wasting a round trip:

- `keyword list` requires `--pattern`;
- `keyword product-ranking` requires `--month` on the US marketplace;
- `agent status` requires `--query-start` and `--query-end`.

## Pagination

```bash
sorftime-team -d us category products --node-id 11139610011 --page 1      # look first
sorftime-team -d us category products --node-id 11139610011 \
  --all-pages --max-pages 5 --page-delay 500                          # then bound it
```

Always fetch page 1 alone before using `--all-pages`, but do not infer the total page count from a
short first page or an undocumented response field. Set `--max-pages` deliberately; the default of
100 is a safety cap, not a recommendation. Registered pagination continues through short non-empty
pages and stops on an empty array or successful `Data: null`; hitting the cap is reported as
`maxPagesReached`. `--page-delay` reduces the chance of hitting the account-global per-minute
limit (`501`) and disrupting colleagues.
