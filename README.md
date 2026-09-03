# Sorftime CLI + Skill

[![CI](https://github.com/ccchenhuohuo/sorftime-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ccchenhuohuo/sorftime-cli/actions/workflows/ci.yml)

面向团队的 Sorftime 数据接入项目：一个覆盖全部 52 个接口的 CLI，加一份指导 AI 选命令、控成本、守口径的 Sorftime Research Skill。

- **CLI**：唯一执行路径。覆盖文档实际列出的全部 52 个接口，凭据存在本机钥匙串或 0600 文件里。
- **Sorftime Research Skill**：负责自然语言路由、成本确认、证据边界和回答规范。它不持有凭据，只调 CLI。

```mermaid
flowchart LR
  U["使用者"] --> H["Codex / Claude Code"]
  H --> K["Sorftime Research Skill"]
  K --> L["sorftime CLI"]
  L --> A["Sorftime API"]
```

## 当前开放策略

**52 个端点开放 41 个**，其余 11 个在发出任何网络请求之前就被拒绝。

**6 个花 Coin 或成本未知**（`--allow-coin` 单次放行）：

| 被拦命令 | 端点 | 计费 |
|---|---|---|
| `product reviews-collect` | `ProductReviewsCollection` | Coin |
| `monitor best-seller-create` | `BestSellerListSubscription` | 周期性 Coin |
| `monitor keyword-create` | `KeywordBatchSubscription` | 周期性 Coin |
| `monitor seller-create` | `ProductSellerSubscription` | 周期性 Coin |
| `monitor asin-update` | `ASINSubscription` | 周期性 Coin |
| `keyword favorite-list` | `GetFavoriteKeyword` | 文档未标明成本，失败关闭 |

**5 个会改动共享账号状态**（`--allow-write` 单次放行）：

| 被拦命令 | 端点 | 后果 |
|---|---|---|
| `keyword favorite-add` | `FavoriteKeyword` | 写入共享关键词词库 |
| `keyword favorite-change` | `ChangeFavoriteKeyword` | 移动或删除词库条目；请求体无文档 |
| `monitor keyword-update` | `KeywordBatchTaskUpdate` | `Update=9` 即删除关键词监控 |
| `monitor best-seller-delete` | `BestSellerListDelete` | 删除榜单监控，**不可恢复** |
| `monitor seller-update` | `ProductSellerTaskUpdate` | 修改或删除卖家/库存监控 |

用这个 CLI 的人拿的是同一把账号级凭据，所以写操作不是「改我自己的数据」，是改所有同事看到的东西。

两道闸都在 `runner.ts` 里，因此对 `sorftime api call` 同样生效；注册表里没有的端点一律按「成本未知」走失败关闭路径。

分类见 [`src/policy.ts`](src/policy.ts)，`sorftime endpoints` 会把 `BILLING` 和 `STATUS` 两列一起打出来。

**request 配额是账号全局的**，不是每人一份。`500`（月度上限）、`501`（每分钟上限）、`694`（次数不足）都可能是同事触发的，遇到就停，不要重试。

## 文档入口

| 内容 | 文档 |
|---|---|
| 使用、安装、认证、命令 | 本 README |
| CLI 与 Skill 的协作协议 | [CLI × Skill 联动](docs/cli-skill-integration.md) |
| 分发、凭据与团队上线清单 | [部署与团队分发](docs/deployment.md) |
| AI 编码代理开发规则（不是用户文档） | [AGENTS.md](AGENTS.md) |
| Claude Code 项目路由 | [CLAUDE.md](CLAUDE.md) |

## 安装 Skill

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME/skills"
cp -R skills/sorftime-research "$CODEX_HOME/skills/sorftime-research"
```

Claude Code 则复制到 `.claude/skills/sorftime-research`。重新加载 Host 后可显式调用 `$sorftime-research`。Skill 只在 `sorftime` 可执行且 `sorftime auth status` 通过时才能工作。

## CLI 要求与安装

- Node.js 20 or later
- pnpm 11 (the repository pins `pnpm@11.7.0`)

Build and install from this repository:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
sorftime --version
```

For local development, no global install is required:

```bash
pnpm exec tsx src/cli.ts --help
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm check` runs type checking, linting, tests, and the production build in sequence.

## CLI 认证

The CLI needs a Sorftime credential for API calls. Never put the real value in source code, a committed `.env` file, command arguments, screenshots, or issue reports.

Interactive login uses a hidden prompt:

```bash
sorftime auth login
sorftime auth status
```

Login stores the credential in `credentials.json` in the CLI config directory with mode `0600`; the directory is created with mode `0700`. This avoids placing the credential in process arguments. Existing credentials from older releases in macOS Keychain remain readable and can be removed with `auth logout`.

For scripts, pass the credential through standard input rather than a command-line argument:

```bash
printf '%s' "$SORFTIME_ACCOUNT_SK" | sorftime auth login --token-stdin
```

You may also use an environment-only credential without saving it:

```bash
read -rsp 'Sorftime credential: ' SORFTIME_ACCOUNT_SK; echo
export SORFTIME_ACCOUNT_SK
sorftime auth status
```

Remove saved credentials with:

```bash
sorftime auth logout
```

Credential lookup order is:

1. `SORFTIME_ACCOUNT_SK`
2. an existing macOS Keychain item from an older release
3. the mode-`0600` credential file

Set `SORFTIME_CREDENTIAL_STORE=file` to disable lookup of an older Keychain item. `auth status` reports only whether a credential is available and its source; it never prints the value.

## CLI 快速开始

List supported marketplaces and all implemented endpoints:

```bash
sorftime domains
sorftime endpoints
sorftime endpoints --group product
sorftime endpoints --json > endpoints.json
```

Run a typed command:

```bash
sorftime --domain us --output json product get \
  --asin B000000001 B000000002 \
  --trend 2
```

Typed flags use kebab-case, while the CLI sends the API's exact field spelling and capitalization. For example, `--node-id` becomes `NodeId`, and the documented `--query-start` becomes `QueryStart`.

Each command has endpoint-specific help, including required parameters, allowed values, and documented cost:

```bash
sorftime product get --help
sorftime monitor keyword-update --help
```

## Commands and endpoint coverage

Utility commands:

| Command | Purpose |
|---|---|
| `auth login/status/logout` | Manage and inspect credential availability |
| `config list/path/get/set/unset` | Manage non-secret defaults |
| `domains` | List 14 marketplace IDs, codes, aliases, and history support |
| `endpoints [--group GROUP] [--json]` | List the complete 52-endpoint catalog and costs |
| `api call <endpoint>` | Call a documented or future endpoint with a raw JSON object |

Typed API commands are organized into six groups:

| Group | Count | Commands |
|---|---:|---|
| `category` | 4 | `tree`, `best-sellers`, `products`, `trend` |
| `product` | 12 | `get`, `search`, `sales-volume`, `variation-history`, `realtime-start`, `realtime-status`, `reviews-collect`, `reviews-status`, `reviews-list`, `similar-start`, `similar-status`, `similar-results` |
| `keyword` | 12 | `list`, `search-results`, `get`, `search-trend`, `by-category`, `by-asin`, `product-ranking`, `asin-ranking`, `extend`, `favorite-add`, `favorite-change`, `favorite-list` |
| `monitor` | 17 | `keyword-create`, `keyword-list`, `keyword-update`, `keyword-runs`, `keyword-run-data`, `best-seller-create`, `best-seller-list`, `best-seller-delete`, `best-seller-data`, `seller-create`, `seller-list`, `seller-update`, `seller-runs`, `seller-run-data`, `asin-update`, `asin-list`, `asin-data` |
| `agent` | 4 | `product`, `category`, `status`, `result` |
| `account` | 3 | `coins`, `coin-stream`, `request-stream` |

`sorftime endpoints --json` is the authoritative machine-readable inventory. It includes the exact API endpoint name, group, CLI command, cost text, parameters, special timeout, pagination support, retry risk, and whether the source documentation omitted the body schema.

## Typed and raw JSON input

### Typed flags

Values are validated and converted according to the endpoint catalog: integers, numeric ranges, enum choices, dates, months, arrays, JSON objects, and image inputs.

```bash
sorftime --domain de category trend \
  --node-id 123456 \
  --trend-index 0

sorftime keyword list \
  --pattern '{"RankCondition":[1,1000]}' \
  --page-index 1 \
  --page-size 20
```

For a JSON-valued typed option, prefix a path with `@` to read the value from a file:

```bash
sorftime keyword list --pattern @./keyword-pattern.json
```

Image search accepts an existing data URI or `@path`; local `.jpg`, `.jpeg`, `.png`, `.webp`, and `.gif` files receive the corresponding MIME type and are Base64-encoded into the JSON request:

```bash
sorftime --domain us product similar-start --image @./product.jpg
```

Verbose diagnostics redact image data.
Local image files are capped at 10 MiB as a memory-safety guard.

### Raw request bodies

Every typed endpoint command, plus `api call`, supports one of these mutually exclusive body sources:

```bash
sorftime product search \
  --data '{"Page":1,"Query":1,"QueryType":"3","Pattern":"example-brand"}'

sorftime keyword favorite-change --data-file ./favorite-change.json

printf '%s\n' '{"Keyword":"power bank"}' | \
  sorftime keyword get --stdin

sorftime --domain us api call ProductQuery --data-file ./request.json
```

Raw input must be a JSON object. `--data-file` and `--stdin` are limited to 25 MiB. Typed flags may be combined with a raw body; typed values overwrite fields with the same exact API key.

`api call` accepts case-insensitive endpoint names and unambiguous CLI command names. If a command name exists in more than one group (such as `get`), use the exact API endpoint name. An unknown endpoint name must start with a letter and contain only letters and digits.

## Configuration and precedence

Store only non-secret defaults in the config file:

```bash
sorftime config set domain us
sorftime config set timeout 120
sorftime config set output json
sorftime config list
sorftime config path
sorftime config get domain
sorftime config unset output
```

Supported config keys are `domain`, `base-url`, `timeout`, and `output`. Attempts to store a credential through `config set` are rejected.

| Setting | Highest to lowest precedence | Fallback |
|---|---|---|
| Marketplace | `--domain` → `SORFTIME_DOMAIN` → config `domain` | `us` |
| Base URL | `--base-url` → `SORFTIME_BASE_URL` → config `base-url` | `https://standardapi.sorftime.com/api/` |
| Timeout | `--timeout` → `SORFTIME_TIMEOUT` → config `timeout` → endpoint default | 60 seconds |
| Retries | `--retries` → `SORFTIME_RETRIES` | `0` |
| Output | `--output` → `SORFTIME_OUTPUT` → config `output` | `table` on a TTY, otherwise `json` |

`CategoryTree` has a 300-second endpoint default and image search has a 120-second default, unless a higher-precedence timeout overrides it. Valid timeouts are 1–3600 seconds; retry count is 0–5.

The config directory is selected in this order:

1. `SORFTIME_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/sorftime`
3. `~/.config/sorftime`

The canonical API base URL is already configured. Override it only for a trusted proxy or local test server; see [Security](#security).

## Marketplaces and history guardrails

`--domain` accepts the numeric ID, two-letter code, or a listed alias. Use `sorftime domains` for the complete mapping.

India, UAE, Australia, Brazil, and Saudi Arabia are documented as not supporting history backfill. For those marketplaces the CLI blocks historical fields on `CategoryRequest`, `ProductRequest`, `AsinSalesVolume`, `KeywordProductRanking`, and `ASINKeywordRanking`.

`--force` bypasses only this client-side marketplace history guard. It does not bypass server authorization, required parameters, cost, or quota, and it is not a confirmation or dry-run mechanism.

## Output

Select a format globally with `--output`/`-o`:

| Format | Behavior |
|---|---|
| `json` | Pretty JSON; add `--compact` for one line |
| `jsonl` | One JSON value per array item, or one line for a scalar/object |
| `yaml` | YAML serialization |
| `csv` | Rows from an array/object; nested values remain JSON inside cells |
| `table` | Human-readable columns, truncated to 200 rows and 40 characters per cell |
| `raw` | Strings without JSON quoting; other values as compact JSON |

Examples:

```bash
# Extract Data/data case-insensitively, then select the first item.
sorftime --output json --data-only --select 0 product get --asin B000000001

# Select an exact dot-separated path; numeric segments index arrays.
sorftime --output yaml --select Data.Items product search \
  --query 1 --query-type 3 --pattern example-brand

# Write through a temporary file and atomically rename it into place.
sorftime --output json --output-file ./category-tree.json category tree

# A path of "-" writes to stdout.
sorftime --output csv --data-only --output-file - keyword list
```

`--select` is case-sensitive and runs after `--data-only`. A missing path is a validation error. Use JSON or an output file for large responses; table display is intentionally abbreviated.

Documented list endpoints support bounded automatic pagination:

```bash
sorftime --all-pages --max-pages 50 --page-delay 250 \
  --output json --data-only keyword list --page-size 200
```

`--all-pages` starts at the supplied `Page`/`PageIndex` (or 1), stops after a short page, and adds `_pagination` metadata when retaining the response envelope. `--max-pages` defaults to 100 and `--page-delay` is milliseconds. Endpoints whose result-array or page-size behavior is not documented reject `--all-pages` instead of guessing. Exact raw output cannot be combined with pagination.

Successful API data goes to stdout. Errors and `--verbose` diagnostics go to stderr, making stdout safe to pipe when the selected output format is machine-readable.

## Errors and exit status

The client accepts both `Code` and `code`, treats business code `0` as success, and keeps the server's original successful payload for output. Known business errors receive a readable message.

| Exit | Meaning |
|---:|---|
| `0` | Success, help, or version output |
| `1` | Unexpected error or command-line parser error |
| `2` | CLI validation or invalid local configuration |
| `3` | Missing credential; also used by unauthenticated `auth status` |
| `4` | Network, timeout, cancellation, or non-2xx HTTP response |
| `5` | Sorftime business error (`Code/code` is non-zero) |
| `130` | Interrupted with Ctrl-C/SIGINT |

HTTP errors and Sorftime business errors are separate: for example, an HTTP 401 is exit 4, while an HTTP-success response containing business `Code: 401` is exit 5.

## Retries, quota, and side effects

Retries default to zero because every Sorftime endpoint is invoked with POST, including reads. `--retries N` retries transport failures, HTTP 408/429/5xx responses, and Sorftime's per-minute throttle code 501 with exponential backoff. A valid HTTP `Retry-After` header is honored up to 30 seconds. Other business errors and other HTTP 4xx responses are not retried.

```bash
sorftime --retries 2 account coins
```

Only enable retries when duplicate processing is acceptable. If the server completed a request but the response was lost, retrying may consume quota again, start a second task, repeat an update, or repeat a delete. The CLI displays documented cost in command help and `endpoints`, but it does not currently estimate the final bill, prompt for confirmation, or provide a dry-run mode. Mutating and paid commands execute immediately.

For known task-creating and mutating endpoints, `--retries` is rejected unless you also pass `--retry-unsafe`. That second flag is an explicit acknowledgment that duplicate state changes or charges are possible.

Particularly important costs and side effects include:

- historical category requests: `category best-sellers` with a date range costs 10 requests per 3-day block, rounded up, so a 30-day window is about 100 requests;
- `agent product` and `agent category`, at 25 requests each;
- long product trends and batch ASIN lookups, billed per ASIN;
- realtime crawls and image search, which create server-side tasks;
- favorite, task update, and pause/start commands.

Coin-spending endpoints are blocked outright rather than merely warned about; see 当前计费策略 above.

## Known source-document limitations

The CLI deliberately avoids inventing undocumented API behavior:

- The source summary says 50 endpoints, but its numbered body contains 52. This CLI implements all 52; the difference is two additional monitoring endpoints.
- Many source URLs misspell the host as `sortime`. The CLI uses the working canonical `standardapi.sorftime.com` base.
- `ChangeFavoriteKeyword`, `GetFavoriteKeyword`, `ProductSellerTasks`, and `ProductSellerTaskUpdate` have no documented body schema and therefore expose no guessed typed body flags. Use `--data`, `--data-file`, or `--stdin` when a body is required; `GetFavoriteKeyword` also has unknown documented cost.
- `ProductQuery` documents multi-condition mode without defining its object structure. Use raw JSON for that mode.
- `KeywordQuery.Pattern` is only partially documented. It is exposed as a JSON value rather than a guessed schema.
- Response envelopes vary in capitalization and most endpoint response schemas are absent. The client performs tolerant envelope checks, preserves unknown fields, and offers `--output raw`/JSON output.
- Pagination metadata is mostly undocumented. Automatic pagination is therefore limited to endpoints with a documented page size and stops on short pages; use `--max-pages` as a hard safety cap.
- Asynchronous APIs use different status lookup keys and incomplete status schemas. Use each family's explicit start, status, and result commands; there is no generic wait/poll command.
- File export/download behavior is not documented. Image search accepts local input, but returned image URLs and AI HTML/Markdown are not downloaded automatically.

- Three parameters the source marks optional are rejected by the API without them (verified live 2026-09-03, business code 10). The CLI now validates them locally: `KeywordQuery.Pattern`, `AIResultQuery.QueryStart`/`QueryEnd`, and `KeywordProductRanking.Month` on the US marketplace.
- `ProductRequest.ASIN` is documented as accepting a batch array, but a JSON array returns `Code 0` with `Data: null` and no charge at any length. Only a comma-separated string works, so the CLI serializes it that way.
- `CategoryTree` is slow and large: measured live on US at 6m33s, 10.4 MB, 35,126 nodes. The endpoint default timeout is 900 s for that reason; always write the result to a file rather than stdout.
- Keyword endpoints accept Amazon Brand Analytics terms only. A non-ABA phrase returns business code 11, which means "not an ABA keyword", not "no search volume".

Consult `sorftime <group> <command> --help` and `sorftime endpoints --json` for what the CLI can validate locally. Server behavior and billing remain authoritative.

## Security

- 每台装了 CLI 的机器上都有一份 Account-SK。Sorftime 的鉴权只有账号级 Account-SK，**没有按人分发的子令牌**，所以分发一次就等于把账号级凭据复制一份；谁泄漏的无法从上游区分。轮换凭据必须所有人同时换。
- 同样地，配额和限流都是账号全局的，本地 CLI 没有跨机器的用量视图。谁花了多少，只能靠 `sorftime account request-stream` 看总量，看不到分人明细。
- Prefer `sorftime auth login` or an injected environment secret. Never include a real credential in shell arguments, committed files, logs, test fixtures, or support bundles.
- `--verbose` never prints the credential and replaces image payloads with a length marker. Raw request fields other than image data are printed, so do not place unrelated secrets in a request body when verbose mode is enabled.
- Custom `--base-url`, `SORFTIME_BASE_URL`, and config `base-url` values receive the credential. Use only endpoints you control and trust. The CLI requires HTTPS, except that plain HTTP is allowed for `localhost`, `127.0.0.1`, and `::1` testing.
- Avoid enabling retries for paid or mutating calls unless duplicate execution is safe.
- Keep output files private: product, keyword, review, seller, usage, and AI results may contain commercially sensitive data.
- Credential and config files are written atomically with restrictive permissions, but environment variables may still be visible to same-user processes or CI logs depending on the operating system and runner.

## 项目结构

```text
.
├── src/cli.ts + src/runner.ts   # 命令表与执行编排
├── src/endpoints.ts             # 全部 52 个端点与参数注册表
├── src/billing.ts               # 计费分类与 Coin 硬闸
├── src/service.ts               # 确定性 API 执行核心
├── src/client.ts                # HTTP/信封/超时/体积处理
├── skills/sorftime-research/    # AI 路由与解释 Skill
├── docs/                        # 联动与分发文档
├── test/                        # CLI/核心/计费/Skill 合约测试
├── AGENTS.md                    # AI 编码代理权威项目说明
└── README.md                    # 人类使用者文档
```

## License

MIT. See [LICENSE](./LICENSE).
