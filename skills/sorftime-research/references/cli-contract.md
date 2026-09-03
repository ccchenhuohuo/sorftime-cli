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

Pagination follows the endpoint's registered result path. It continues after short non-empty pages
and stops only on an empty array, successful `Data: null`, or `--max-pages`; it never guesses among
arbitrary arrays. First-page `Data: null` remains null, and a non-empty cap is marked
`_pagination.maxPagesReached`. Unknown upstream metadata remains untouched and is explicitly labeled
with `_pagination.upstreamMetadataFromPage` rather than being reinterpreted.

Request bodies for undocumented endpoints go through `--data <json>`, `--data-file <path>`, or
`--stdin`. `sorftime api call <Endpoint>` accepts registered endpoints only and uses their complete
registry contract, including required fields, wire encoding, pagination, timeout, and retry risk.
Unknown names are rejected with guidance to run `sorftime endpoints`.

## Credentials

```bash
sorftime auth login              # interactive prompt
sorftime auth login --token-stdin # for scripts
sorftime auth status             # reports availability, never the value
sorftime auth logout
```

`auth login` always writes the credential to a mode-0600 file; an OS keychain item is only read
for backwards compatibility with an older release. Existing credential files are rejected if they
are symlinks, non-regular files, owned by someone else, or group/other-accessible. The credential is
never accepted as a command-line flag and never appears in output, `--verbose` diagnostics, or error
text. Never ask the user to paste it into the conversation.

`sorftime config set domain|base-url|timeout|output` holds non-secret defaults. `config set` refuses
credential-shaped keys.

## Blocked by policy

41 of 52 endpoints are open. The blocked union has eleven endpoints. Eight have current,
recurring, or unknown Coin consequences; nine change shared account state; six are in both sets.
The axes are independent, so the four subscription creators plus `monitor keyword-update` and
`monitor seller-update` require both `--allow-coin` and `--allow-write`. Single-axis commands still
require only their matching override. The block is enforced in the runner and therefore also
applies to `api call`.

`sorftime endpoints` prints `open`, `COIN`, `WRITE`, or `COIN+WRITE`; JSON discovery returns the
corresponding `blocked` array. The Skill must never add either override on its own initiative.

## Credential destination

The Account-SK is sent automatically only to the canonical Sorftime origin or a loopback test
origin. URL userinfo is forbidden. A remote proxy must be approved outside an ordinary query by a
deployment administrator setting `SORFTIME_TRUSTED_ORIGINS` to a comma-separated exact HTTPS-origin
allowlist; paths, queries, fragments, and userinfo are not accepted in that allowlist.

## Upstream status codes

`0` success. `9` restricted resource. `10` invalid parameters. `400` unauthenticated IP.
`401` endpoint not enabled for this account. `402` no permission. `500` monthly request limit
reached. `501` per-minute limit. `694` insufficient requests.

`500`, `501`, and `694` are account-global: they can be triggered by someone else's usage. Report
them and stop; do not retry into a limit.

## Exit codes

`0` success. `3` not authenticated. Non-zero otherwise, with a sanitized message on stderr.
