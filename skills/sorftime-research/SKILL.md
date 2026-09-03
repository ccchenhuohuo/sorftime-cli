---
name: sorftime-research
description: "Query Amazon marketplace data through the local Sorftime CLI - category Best Sellers and trends, product detail and sales, keyword search volume and rankings, existing monitors, and shared-account quota. Trigger when users mention Sorftime, an ASIN, an Amazon category NodeId, Best Seller rankings, keyword search volume, or Amazon marketplace research. Discover billing first: free calls cost zero, while every non-free call needs explicit cost agreement; never enable Coin or shared-state overrides on your own initiative."
---

# Sorftime Research

The `sorftime-team` CLI is the execution and policy boundary. This Skill routes intent to a command,
confirms cost before spending, and bounds interpretation of what comes back. Run commands with
Bash; never ask the user for the Account-SK and never print it.

## Before the first call

Check that a credential is available:

```bash
sorftime-team auth status
```

If it reports "Not authenticated", stop and tell the user to run `sorftime-team auth login`. Do not
attempt to authenticate for them.

When you are unsure whether an endpoint exists, what it costs, or whether it is blocked, ask the
CLI instead of guessing:

```bash
sorftime-team endpoints --group category
```

Trust that output over anything remembered. It is generated from the endpoint registry and shows
the billing kind and blocked status of all 52 endpoints (41 open, 11 blocked).

## Cost is the main constraint

Before proposing an API command, use `sorftime-team endpoints --json` or endpoint help to verify its
current billing. `free` means zero request-quota and zero Coin cost. Any `request`, `coin`,
`recurring_coin`, or `unknown` call requires you to name the endpoint, marketplace, and estimated
cost and obtain the user's agreement before executing it. For a batch or workflow, also report and
confirm the total estimated cost. Request quota is one account-global pool for the whole team, not
a per-person allowance.

The following free call can show the shared request balance without consuming it:

```bash
sorftime-team account request-stream
```

Rules that keep spend predictable:

1. Do not execute any non-free call until the user agrees to the stated cost. There is no
   "small enough to skip confirmation" exception.
2. `--all-pages` multiplies cost by the number of pages. Never combine it with an unbounded
   `--max-pages` on a first attempt; fetch one page, look at the shape, then decide.
3. Historical ranges are billed per block, not per call. `category best-sellers` costs 10 requests
   per 3-day block, rounded up - a 30-day window is 100 requests, not 10.
4. `agent product` and `agent category` cost 25 requests each. Do not call them to summarize
   something you could read from cheaper endpoints and interpret yourself.
5. A nonexistent or delisted ASIN can still consume quota. Verify identifiers before batching.
6. Retries are off by default and should stay off. A lost response must not double-spend.

## What this deployment does not expose

41 of the 52 endpoints are open. The blocked union contains 11 endpoints. The two policy axes are
independent: eight can spend Coin (now or through monitoring they start/change), nine write shared
state, and six belong to both sets. A dual-axis endpoint needs both overrides.

| Command | Endpoint | Required overrides | Consequence |
|---|---|---|---|
| `product reviews-collect` | `ProductReviewsCollection` | `--allow-coin` | Starts Coin-billed review collection. |
| `keyword favorite-list` | `GetFavoriteKeyword` | `--allow-coin` | Coin cost is undocumented and therefore fails closed. |
| `keyword favorite-add` | `FavoriteKeyword` | `--allow-write` | Adds a term to the shared keyword dictionary. |
| `keyword favorite-change` | `ChangeFavoriteKeyword` | `--allow-write` | Moves or deletes a shared dictionary term; body is undocumented. |
| `monitor keyword-create` | `KeywordBatchSubscription` | `--allow-coin` + `--allow-write` | Creates shared recurring Coin monitoring. |
| `monitor keyword-update` | `KeywordBatchTaskUpdate` | `--allow-coin` + `--allow-write` | Can start, modify, pause, or delete shared recurring Coin monitoring. |
| `monitor best-seller-create` | `BestSellerListSubscription` | `--allow-coin` + `--allow-write` | Creates or changes shared recurring Coin monitoring. |
| `monitor best-seller-delete` | `BestSellerListDelete` | `--allow-write` | Deletes a shared Best Seller monitor with no undo. |
| `monitor seller-create` | `ProductSellerSubscription` | `--allow-coin` + `--allow-write` | Creates shared recurring Coin seller/stock monitoring. |
| `monitor seller-update` | `ProductSellerTaskUpdate` | `--allow-coin` + `--allow-write` | Undocumented body can change shared recurring Coin monitoring. |
| `monitor asin-update` | `ASINSubscription` | `--allow-coin` + `--allow-write` | Adds or removes shared Coin-billed daily subscriptions. |

Everyone using this CLI holds the same account-level credential, so a write is not "my data" - it
changes what every colleague sees, and the delete has no undo.

When a user asks for one of these, say plainly that it is unavailable by default and why. Do not
silently substitute a different endpoint. `--allow-coin` and `--allow-write` exist for a deliberate
operator decision; never pass either on your own initiative. For a dual-axis endpoint, separate
approval for only one consequence does not authorize the other flag.

Reading existing monitors stays free (`monitor best-seller-data`, `monitor keyword-runs`,
`monitor asin-data`, and their list commands). If no subscription exists, those return nothing,
and that is "no monitor configured", not "no market activity".

## Route the request

Prefix every marketplace command with the marketplace: `-d us`, `-d de`, `-d jp`, and so on.

| Intent | Endpoint | Command | Documented cost |
|---|---|---|---|
| Category Top 100 or date-range Best Sellers | `CategoryRequest` | `sorftime-team -d us category best-sellers --node-id <NodeId>` | `5 realtime; 10 per historical 3-day block` |
| Category structure / NodeId lookup, last resort | `CategoryTree` | `sorftime-team -d us category tree` | `5 requests; 6-10 minutes, 10 MB` |
| Hot products in a category | `CategoryProducts` | `sorftime-team -d us category products --node-id <NodeId>` | `5 requests` |
| Category-level metric over time | `CategoryTrend` | `sorftime-team -d us category trend --node-id <NodeId> --trend-index <0-15>` | `5 requests` |
| Product detail and trends | `ProductRequest` | `sorftime-team -d us product get --asin <ASIN>` | `1 per ASIN; 2 for trends longer than 15 days` |
| Amazon-reported child-ASIN sales | `AsinSalesVolume` | `sorftime-team -d us product sales-volume --asin <ASIN>` | `1 request` |
| Find products by brand/price/BSR/fulfilment | `ProductQuery` | `sorftime-team -d us product search --query-type <1-16> --pattern <value>` | `5 requests` |
| Read already-collected reviews | `ProductReviewsQuery` | `sorftime-team -d us product reviews-list --asin <ASIN>` | `5 requests` |
| Keyword search volume and CPC | `KeywordRequest` | `sorftime-team -d us keyword get --keyword <keyword>` | `1 request` |
| Keywords for an ASIN | `ASINRequestKeyword` | `sorftime-team -d us keyword by-asin --asin <ASIN>` | `1 request` |
| Keywords for a category | `CategoryRequestKeyword` | `sorftime-team -d us keyword by-category --node-id <NodeId>` | `1 request` |
| ASIN rank trend under a keyword | `ASINKeywordRanking` | `sorftime-team -d us keyword asin-ranking --keyword <keyword> --asin <ASIN>` | `2 requests` |
| Existing Best Seller monitor results | `BestSellerListDataCollect` | `sorftime-team -d us monitor best-seller-data --node-id <NodeId> --best-seller-list-type 5 --query-date "<YYYY-MM-DD HH>"` | `free` |
| Shared request balance | `RequestStreamMonth` | `sorftime-team account request-stream` | `free` |
| Shared Coin balance | `CoinQuery` | `sorftime-team account coins` | `free` |

For the exact flag names of any endpoint, read its help rather than guessing:
`sorftime-team category best-sellers --help`.

## Clarify before calling

Ask for the smallest missing selector, and never fill it in yourself:

- marketplace, when the question is not obviously about one site;
- a category NodeId - never turn a category name into an ID from memory. **Ask the user first.**
  A NodeId is visible in any Amazon Best Sellers URL, so the user can usually paste one in seconds.
  `category tree` is the last resort: it is the only endpoint that maps names to IDs, but it costs
  5 requests and takes 6-10 minutes to return about 10 MB, which you then search locally. Never
  start it without saying how long it will take and getting agreement;
- a 10-character ASIN - do not turn a product title into an ASIN;
- a date or month range, and whether history is really needed given the per-block cost.

Never invent an ASIN, NodeId, TaskId, or ScheduleId. If the user's identifier looks malformed,
say so instead of correcting it silently.

## Execute conservatively

1. Run one command at a time and read the result before deciding the next.
2. Default output is JSON when piped. Use `--select <path>` or `--data-only` to keep large
   payloads readable; use `--output-file` for anything big.
3. `category tree` returns about 10 MB after 6-10 minutes (measured on US). Always write it to a
   file, warn the user about the wait before starting, and never poll or re-run it - a second
   call bills another 5 requests and the first one is still coming.
4. Stop and report on upstream codes rather than retrying: `500` monthly quota exhausted, `501`
   per-minute limit, `694` insufficient requests, `400` unauthenticated IP, `401` endpoint not
   enabled, `402` no permission, `9` restricted resource.
5. `501` means the whole account is being rate-limited, possibly by a colleague running something
   else. Wait rather than retrying in a loop.
6. History is unsupported for IN, AU, AE, BR, and SA. The CLI blocks it; `--force` sends anyway and
   may waste quota. Do not pass `--force` without asking.

## Answer from evidence

State the marketplace, the endpoint, and the observation time for every number. Then apply
[references/interpretation-boundaries.md](references/interpretation-boundaries.md) - read it before
comparing two results, explaining a change, or reporting anything as zero.

Read [references/cli-contract.md](references/cli-contract.md) for the full command surface, global
flags, and output handling. Read [references/workflows.md](references/workflows.md) for the
asynchronous flows and multi-step recipes.
