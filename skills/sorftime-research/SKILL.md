---
name: sorftime-research
description: Query Amazon marketplace data through the local Sorftime CLI - category Best Sellers and trends, product detail and sales, keyword search volume and rankings, existing monitors, and shared-account quota. Trigger when users mention Sorftime, an ASIN, an Amazon category NodeId, Best Seller rankings, keyword search volume, or Amazon marketplace research. Every call spends the shared request quota, so confirm scope before running; never spend Coin and never change shared account state.
---

# Sorftime Research

The `sorftime` CLI is the execution and policy boundary. This Skill routes intent to a command,
confirms cost before spending, and bounds interpretation of what comes back. Run commands with
Bash; never ask the user for the Account-SK and never print it.

## Before the first call

Check that a credential is available:

```bash
sorftime auth status
```

If it reports "Not authenticated", stop and tell the user to run `sorftime auth login`. Do not
attempt to authenticate for them.

When you are unsure whether an endpoint exists, what it costs, or whether it is blocked, ask the
CLI instead of guessing:

```bash
sorftime endpoints --group category
```

Trust that output over anything remembered. It is generated from the endpoint registry and shows
the billing kind and blocked status of all 52 endpoints (41 open, 11 blocked).

## Cost is the main constraint

**Every data call spends the account-global monthly request quota.** It is one shared pool for the
whole team, not a per-person allowance. Before any bulk or exploratory work:

```bash
sorftime account request-stream
```

Rules that keep spend predictable:

1. Confirm scope with the user before spending more than a few requests. Name the endpoint, the
   marketplace, and the estimated cost.
2. `--all-pages` multiplies cost by the number of pages. Never combine it with an unbounded
   `--max-pages` on a first attempt; fetch one page, look at the shape, then decide.
3. Historical ranges are billed per block, not per call. `category best-sellers` costs 10 requests
   per 3-day block, rounded up - a 30-day window is 100 requests, not 10.
4. `agent product` and `agent category` cost 25 requests each. Do not call them to summarize
   something you could read from cheaper endpoints and interpret yourself.
5. A nonexistent or delisted ASIN can still consume quota. Verify identifiers before batching.
6. Retries are off by default and should stay off. A lost response must not double-spend.

## What this deployment does not expose

41 of the 52 endpoints are open. The other 11 are refused before any network call.

**Six spend Coin or have an undocumented cost** (`--allow-coin`):

| Blocked | Consequence |
|---|---|
| `product reviews-collect` | Review text cannot be collected. Only already-collected reviews are readable. |
| `monitor best-seller-create` | No new Best Seller / New Releases / Most Wished / Gift Ideas monitors. |
| `monitor keyword-create` | No new keyword rank monitors. |
| `monitor seller-create` | No new seller/stock monitors. |
| `monitor asin-update` | No new daily ASIN subscriptions. |
| `keyword favorite-list` | Undocumented cost; treated as Coin-spending, fail-closed. |

**Five change shared account state** (`--allow-write`):

| Blocked | Consequence |
|---|---|
| `keyword favorite-add` | Cannot add a term to the shared keyword dictionary. |
| `keyword favorite-change` | Cannot move or delete a dictionary term; its body is undocumented. |
| `monitor keyword-update` | Cannot modify, pause, or delete a keyword monitor. |
| `monitor best-seller-delete` | Cannot delete a Best Seller monitor. There is no undo. |
| `monitor seller-update` | Cannot modify or delete a seller/stock monitor. |

Everyone using this CLI holds the same account-level credential, so a write is not "my data" - it
changes what every colleague sees, and the delete has no undo.

When a user asks for one of these, say plainly that it is unavailable and why. Do not silently
substitute a different endpoint. `--allow-coin` and `--allow-write` exist for a deliberate operator
decision - never pass either on your own initiative; ask first and let the user decide.

Reading existing monitors stays free (`monitor best-seller-data`, `monitor keyword-runs`,
`monitor asin-data`, and their list commands). If no subscription exists, those return nothing,
and that is "no monitor configured", not "no market activity".

## Route the request

Prefix every command with the marketplace: `-d us`, `-d de`, `-d jp`, and so on.

| Intent | Command | Cost |
|---|---|---|
| Category Top 100 Best Sellers | `sorftime -d us category best-sellers --node-id <id>` | 5 |
| Best Sellers over a date range | same, plus `--query-start` / `--query-date` | 10 per 3 days |
| Category structure / NodeId lookup | `sorftime -d us category tree` | 5, large response |
| Hot products in a category | `sorftime -d us category products --node-id <id>` | 5 |
| Category-level metric over time | `sorftime -d us category trend --node-id <id> --trend-index <0-15>` | 5 |
| Product detail, daily price/sales/rank trends | `sorftime -d us product get --asin <ASIN>` | 1-2 per ASIN |
| Amazon-reported child-ASIN sales | `sorftime -d us product sales-volume --asin <ASIN>` | 1 |
| Find products by brand/price/BSR/fulfilment | `sorftime -d us product search --query-type <n> --pattern <v>` | 5 |
| Read already-collected reviews | `sorftime -d us product reviews-list --asin <ASIN>` | 5 |
| Keyword search volume and CPC | `sorftime -d us keyword get --keyword "<kw>"` | 1 |
| Keywords for an ASIN or category | `sorftime -d us keyword by-asin --asin <ASIN>` / `keyword by-category --node-id <id>` | 1 |
| ASIN rank trend under a keyword | `sorftime -d us keyword asin-ranking --keyword "<kw>" --asin <ASIN>` | 2 |
| Existing monitor results | `sorftime -d us monitor best-seller-data --node-id <id> --best-seller-list-type 5 --query-date "<YYYY-MM-DD HH>"` | free |
| Quota and Coin balance | `sorftime account request-stream` / `sorftime account coins` | free |

For the exact flag names of any endpoint, read its help rather than guessing:
`sorftime category best-sellers --help`.

## Clarify before calling

Ask for the smallest missing selector, and never fill it in yourself:

- marketplace, when the question is not obviously about one site;
- a category NodeId - do not turn a category name into an ID from memory; use `category tree` or
  ask the user;
- a 10-character ASIN - do not turn a product title into an ASIN;
- a date or month range, and whether history is really needed given the per-block cost.

Never invent an ASIN, NodeId, TaskId, or ScheduleId. If the user's identifier looks malformed,
say so instead of correcting it silently.

## Execute conservatively

1. Run one command at a time and read the result before deciding the next.
2. Default output is JSON when piped. Use `--select <path>` or `--data-only` to keep large
   payloads readable; use `--output-file` for anything big.
3. `category tree` can exceed 10 MB. Write it to a file rather than into the transcript.
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
