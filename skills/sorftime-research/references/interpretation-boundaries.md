# Interpretation boundaries

## Evidence and time

- Attach the marketplace, the endpoint, and the observation time to every number.
- Distinguish when you fetched the data from when Sorftime observed it. Most endpoints lag; the
  latest supported Best Sellers date is today minus 2 days.
- Existing monitoring and subscription data is not realtime unless its own timestamp says so.
- An empty response means no matching record under the parameters you sent. It is not a zero.

## Metric semantics

- Sales figures are **market estimates**, not merchant-reported revenue. Do not call them GMV,
  actual sales, or order counts.
- Monetary values use the marketplace's smallest currency unit. `2699` is 26.99.
- Amounts are in site-local currency. Never add or rank local-currency amounts across
  marketplaces; there is no exchange rate in the response.
- A Top 100 list is a **truncated set**. Do not compute market share, brand concentration, or
  category totals from it.
- Historical Best Sellers rows are de-duplicated by parent ASIN, and their sales value is the last
  day's rolling 30-day figure, not a sum over the requested range.
- Rank and sales are different measurements. A rank change is not a sales change.

## Reading an empty or rejected response

Verified live 2026-09-03. These look alike in a terminal and mean different things:

- **`code 11` on a keyword endpoint** means the term is not in Amazon Brand Analytics. Every
  keyword endpoint accepts ABA terms only. It does **not** mean the phrase has no search volume.
  Say "not an ABA keyword" and offer to find real ones via `keyword by-asin` or `keyword by-category`.
- **`code 11` on a monitor read** means no monitor covers that node, type, and hour - or the
  monitor exists but has no retrievable data. It is not "no market activity".
- **`code 10`** is a malformed request, not an empty result. Report it as a request problem.
- **`Data: null` with `Code: 0`** is a successful call that returned nothing. Treat it as no
  matching record, and never as zero.

## Claims

Allowed:

- describe an observed rank, list membership, price point, review distribution, or quota state;
- compare two explicitly fetched results when the marketplace, endpoint, and time basis match;
- point out that a value rose or fell between two observations;
- explain scope, missing data, cost, rate limits, and policy restrictions.

Not allowed:

- infer causality - do not say a price change caused a rank change, or that a competitor's action
  drove a result;
- forecast, or recommend entering, exiting, pricing, or delisting;
- claim complete Amazon coverage from a category, keyword, or monitor sample;
- describe the shared account quota as one person's allowance;
- invent an ASIN, NodeId, TaskId, or ScheduleId, or repair a malformed one silently;
- present missing, unavailable, blocked, or forbidden data as zero;
- hide that an endpoint was blocked, or substitute a different endpoint without saying so;
- present Sorftime estimates as agreeing with another data source without checking; independent
  estimates of the same market routinely diverge at the individual-product level even when their
  totals are close.

## Cost and credentials

- Never ask for, display, or write the Account-SK, and never accept one pasted into the chat.
- Check each prospective command in CLI discovery first. State that `free` costs zero; for every
  non-free command, name the endpoint, marketplace, estimated cost, and stop until the user agrees.
- Never pass `--allow-coin`, `--allow-write`, or `--force` on your own initiative. A command that
  needs both policy overrides requires the user to approve both consequences separately.
- The quota is shared. If you hit `500`, `501`, or `694`, report it as an account-level condition -
  it may be caused by a colleague - and stop rather than retrying.
