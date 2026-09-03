# CLI contract

The `sorftime` CLI is the only execution path. It covers all 52 documented Sorftime endpoints,
grouped into six command groups.

## Discovery

```bash
sorftime endpoints                 # all endpoints with billing kind and blocked status
sorftime endpoints --group keyword # one group
sorftime endpoints --json          # machine-readable, includes `billing` and `blocked`
sorftime domains                   # marketplaces and history-backfill support
sorftime <group> <command> --help  # exact flags for one endpoint
```

Prefer these over recalling a signature. The registry is the source of truth; this file is not.

## Command groups

| Group | Covers |
|---|---|
| `category` | `tree`, `best-sellers`, `products`, `trend` |
| `product` | `get`, `search`, `sales-volume`, `variation-history`, `realtime-start`, `realtime-status`, `reviews-collect`, `reviews-status`, `reviews-list`, `similar-start`, `similar-status`, `similar-results` |
| `keyword` | `list`, `search-results`, `get`, `search-trend`, `by-category`, `by-asin`, `product-ranking`, `asin-ranking`, `extend`, `favorite-add`, `favorite-change`, `favorite-list` |
| `monitor` | keyword / Best Seller / seller-stock / ASIN subscription tasks and their run data |
| `agent` | `product`, `category`, `status`, `result` |
| `account` | `coins`, `coin-stream`, `request-stream` |

Flag names are the documented body parameter in kebab-case: `NodeId` becomes `--node-id`,
`BestSellerListType` becomes `--best-seller-list-type`, `QueryTrendStartDt` becomes
`--query-trend-start-dt`.

## Global flags

| Flag | Effect |
|---|---|
| `-d, --domain` | Marketplace code or ID. Required in practice; defaults to `us`. |
| `-o, --output` | `json`, `jsonl`, `yaml`, `csv`, `table`, `raw`. Defaults to `table` on a TTY, `json` when piped. |
| `--select <path>` | Dot-separated path into the response. |
| `--data-only` | Emit only the `Data` field of the envelope. |
| `--output-file <path>` | Write atomically to a file instead of stdout. |
| `--all-pages` | Aggregate every page. **Multiplies cost.** |
| `--max-pages` | Cap for `--all-pages`, 1-1000, default 100. |
| `--page-delay` | Milliseconds between pages. |
| `--retries` | 0-5, default 0. Off by default on purpose. |
| `--retry-unsafe` | Required before retrying a task-creating endpoint. |
| `--force` | Bypass the marketplace history guardrail. |
| `--allow-coin` | Permit one Coin-spending call. Operator decision only. |
| `--allow-write` | Permit one call that changes shared account state. Operator decision only. |
| `--verbose` | Safe diagnostics to stderr; never prints the credential. |

Request bodies for undocumented endpoints go through `--data <json>`, `--data-file <path>`, or
`--stdin`. `sorftime api call <Endpoint>` is the raw escape hatch for anything not in the registry;
it is fail-closed on cost and needs `--allow-coin`.

## Credentials

```bash
sorftime auth login              # interactive prompt
sorftime auth login --token-stdin # for scripts
sorftime auth status             # reports availability, never the value
sorftime auth logout
```

`auth login` always writes the credential to a mode-0600 file; an OS keychain item is only read
for backwards compatibility with an older release. It is never accepted as a command-line flag and never appears in output, `--verbose` diagnostics, or
error text. Never ask the user to paste it into the conversation.

`sorftime config set domain|base-url|timeout|output` holds non-secret defaults. `config set` refuses
credential-shaped keys.

## Blocked by policy

41 of 52 endpoints are open. Eleven are refused before any network call:

- **Coin or undocumented cost** (`--allow-coin`): `product reviews-collect`,
  `monitor best-seller-create`, `monitor keyword-create`, `monitor seller-create`,
  `monitor asin-update`, `keyword favorite-list`.
- **Changes shared account state** (`--allow-write`): `keyword favorite-add`,
  `keyword favorite-change`, `monitor keyword-update`, `monitor best-seller-delete`,
  `monitor seller-update`.

The block is enforced in the runner, so it applies to `api call` too. Anything absent from the
registry is treated as Coin-spending on the same fail-closed path. `sorftime endpoints` prints a
`STATUS` column of `open`, `COIN`, or `WRITE`.

## Upstream status codes

`0` success. `9` restricted resource. `10` invalid parameters. `400` unauthenticated IP.
`401` endpoint not enabled for this account. `402` no permission. `500` monthly request limit
reached. `501` per-minute limit. `694` insufficient requests.

`500`, `501`, and `694` are account-global: they can be triggered by someone else's usage. Report
them and stop; do not retry into a limit.

## Exit codes

`0` success. `3` not authenticated. Non-zero otherwise, with a sanitized message on stderr.
