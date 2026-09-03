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

两个分类轴独立且允许重叠：**8 个**端点可能花 Coin（本次、未来周期或成本未知），**9 个**
端点会改动共享账号状态，其中 **6 个同时属于两类**；并集仍是 11 个。双属性端点必须同时
提供 `--allow-coin` 与 `--allow-write`，只给一个仍会在请求前被拦。

| 被拦命令 | 端点 | 单次放行所需 flag | 后果 |
|---|---|---|---|
| `product reviews-collect` | `ProductReviewsCollection` | `--allow-coin` | Coin 计费的评论采集 |
| `keyword favorite-list` | `GetFavoriteKeyword` | `--allow-coin` | 成本未标明，按 Coin 失败关闭 |
| `keyword favorite-add` | `FavoriteKeyword` | `--allow-write` | 写入共享关键词词库 |
| `keyword favorite-change` | `ChangeFavoriteKeyword` | `--allow-write` | 移动或删除共享词库条目；请求体无文档 |
| `monitor keyword-create` | `KeywordBatchSubscription` | `--allow-coin` + `--allow-write` | 新建共享的周期性 Coin 监控 |
| `monitor keyword-update` | `KeywordBatchTaskUpdate` | `--allow-coin` + `--allow-write` | 可启动、修改、暂停或删除周期性 Coin 监控 |
| `monitor best-seller-create` | `BestSellerListSubscription` | `--allow-coin` + `--allow-write` | 新建或修改共享的周期性 Coin 监控 |
| `monitor best-seller-delete` | `BestSellerListDelete` | `--allow-write` | 删除榜单监控，**不可恢复** |
| `monitor seller-create` | `ProductSellerSubscription` | `--allow-coin` + `--allow-write` | 新建共享的周期性 Coin 卖家/库存监控 |
| `monitor seller-update` | `ProductSellerTaskUpdate` | `--allow-coin` + `--allow-write` | 请求体无文档，按最坏后果处理 |
| `monitor asin-update` | `ASINSubscription` | `--allow-coin` + `--allow-write` | 增删共享的 Coin 计费日更订阅 |

用这个 CLI 的人拿的是同一把账号级凭据，所以写操作不是「改我自己的数据」，是改所有同事看到的东西。

两道闸都在 `runner.ts` 里，因此对 `sorftime-team api call` 同样生效。`api call` 只接受注册表中的
端点；未知名称会直接拒绝并提示运行 `sorftime-team endpoints`。

分类见 [`src/policy.ts`](src/policy.ts)，`sorftime-team endpoints` 会把 `BILLING` 和 `STATUS` 两列一起打出来。

**request 配额是账号全局的**，不是每人一份。`500`（月度上限）、`501`（每分钟上限）、`694`（次数不足）都可能是同事触发的，遇到就停，不要重试。

## 文档入口

| 内容 | 文档 |
|---|---|
| 使用、安装、认证、命令 | 本 README |
| CLI 与 Skill 的协作协议 | [CLI × Skill 联动](docs/cli-skill-integration.md) |
| 分发、凭据与团队上线清单 | [部署与团队分发](docs/deployment.md) |
| AI 编码代理开发规则（不是用户文档） | [AGENTS.md](AGENTS.md) |
| Claude Code 项目路由 | [CLAUDE.md](CLAUDE.md) |

## 安装

需要 Node.js 20+。从 Release 的 tarball 一条命令装好，不需要 clone、不需要构建工具：

```bash
npm install -g https://github.com/ccchenhuohuo/sorftime-cli/releases/latest/download/sorftime-cli.tgz
sorftime-team --version
sorftime-team skill              # 装 Skill 到 ~/.claude/skills/
sorftime-team skill --host codex # 或装到 $CODEX_HOME/skills/
```

升级就是重跑前两条命令。Skill 随包分发，`skill` 子命令会把它复制到 Host 目录，不用手动找路径。

> 命令名是 `sorftime-team`，不是 `sorftime`。服务商官方 CLI（`npm install -g sorftime-cli`）
> 占用了 `sorftime` 这个命令名，两者可以共存互不干扰。

**不要用 `npm install -g github:ccchenhuohuo/sorftime-cli`**：npm 的全局 git 安装会静默地
只建一个空符号链接，报告 "added N packages" 却不装任何可执行文件，没有任何错误提示。

从源码安装（需要 pnpm 11，仓库钉在 `pnpm@11.7.0`）：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
sorftime-team --version
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
sorftime-team auth login
sorftime-team auth status
```

Login stores the credential in `credentials.json` in the CLI config directory with mode `0600`; the directory is created with mode `0700`. This avoids placing the credential in process arguments. Existing credentials from older releases in macOS Keychain remain readable and can be removed with `auth logout`.

读取已有凭据文件时也会强制检查安全边界：必须是当前用户拥有的普通文件、不得是符号链接，
并且在 POSIX 平台不能给 group/other 任何权限；例如复制后变成 `0644` 会被拒绝并提示
`chmod 600`，错误消息不会包含凭据值。

For scripts, pass the credential through standard input rather than a command-line argument:

```bash
printf '%s' "$SORFTIME_ACCOUNT_SK" | sorftime-team auth login --token-stdin
```

You may also use an environment-only credential without saving it:

```bash
read -rsp 'Sorftime credential: ' SORFTIME_ACCOUNT_SK; echo
export SORFTIME_ACCOUNT_SK
sorftime-team auth status
```

Remove saved credentials with:

```bash
sorftime-team auth logout
```

Credential lookup order is:

1. `SORFTIME_ACCOUNT_SK`
2. an existing macOS Keychain item from an older release
3. the mode-`0600` credential file

Set `SORFTIME_CREDENTIAL_STORE=file` to disable lookup of an older Keychain item. `auth status` reports only whether a credential is available and its source; it never prints the value.

## CLI 快速开始

List supported marketplaces and all implemented endpoints:

```bash
sorftime-team domains
sorftime-team endpoints
sorftime-team endpoints --group product
sorftime-team endpoints --json > endpoints.json
```

Run a typed command:

```bash
sorftime-team --domain us --output json product get \
  --asin B000000001 B000000002 \
  --trend 2
```

Typed flags use kebab-case, while the CLI sends the API's exact field spelling and capitalization. For example, `--node-id` becomes `NodeId`, and the documented `--query-start` becomes `QueryStart`.

Each command has endpoint-specific help, including required parameters, allowed values, and documented cost:

```bash
sorftime-team product get --help
sorftime-team monitor keyword-update --help
```

## Commands and endpoint coverage

Utility commands:

| Command | Purpose |
|---|---|
| `auth login/status/logout` | Manage and inspect credential availability |
| `config list/path/get/set/unset` | Manage non-secret defaults |
| `domains` | List 14 marketplace IDs, codes, aliases, and history support |
| `endpoints [--group GROUP] [--json]` | List the complete 52-endpoint catalog and costs |
| `skill [--host claude\|codex] [--dir PATH]` | 把随包分发的 Skill 装进 AI Host |
| `api call <endpoint>` | Call a registered endpoint with a raw JSON object while retaining its full contract |

Typed API commands are organized into six groups:

| Group | Count | Commands |
|---|---:|---|
| `category` | 4 | `tree`, `best-sellers`, `products`, `trend` |
| `product` | 12 | `get`, `search`, `sales-volume`, `variation-history`, `realtime-start`, `realtime-status`, `reviews-collect`, `reviews-status`, `reviews-list`, `similar-start`, `similar-status`, `similar-results` |
| `keyword` | 12 | `list`, `search-results`, `get`, `search-trend`, `by-category`, `by-asin`, `product-ranking`, `asin-ranking`, `extend`, `favorite-add`, `favorite-change`, `favorite-list` |
| `monitor` | 17 | `keyword-create`, `keyword-list`, `keyword-update`, `keyword-runs`, `keyword-run-data`, `best-seller-create`, `best-seller-list`, `best-seller-delete`, `best-seller-data`, `seller-create`, `seller-list`, `seller-update`, `seller-runs`, `seller-run-data`, `asin-update`, `asin-list`, `asin-data` |
| `agent` | 4 | `product`, `category`, `status`, `result` |
| `account` | 3 | `coins`, `coin-stream`, `request-stream` |

`sorftime-team endpoints --json` is the authoritative machine-readable inventory. It includes the exact API endpoint name, group, CLI command, cost text, parameters, history/pagination contracts, special timeout, retry risk, effect, and a `blocked` array that can contain both `coin` and `write`.

## Typed and raw JSON input

### Typed flags

Values are validated and converted according to the endpoint catalog: integers, numeric ranges, enum choices, dates, months, arrays, JSON objects, and image inputs.

```bash
sorftime-team --domain de category trend \
  --node-id 123456 \
  --trend-index 0

sorftime-team keyword list \
  --pattern '{"RankCondition":[1,1000]}' \
  --page-index 1 \
  --page-size 20
```

For a JSON-valued typed option, prefix a path with `@` to read the value from a file:

```bash
sorftime-team keyword list --pattern @./keyword-pattern.json
```

Image search accepts an existing data URI or `@path`; local `.jpg`, `.jpeg`, `.png`, `.webp`, and `.gif` files receive the corresponding MIME type and are Base64-encoded into the JSON request:

```bash
sorftime-team --domain us product similar-start --image @./product.jpg
```

Verbose diagnostics redact image data.
Local image files are capped at 10 MiB as a memory-safety guard.

### Raw request bodies

Every typed endpoint command, plus `api call`, supports one of these mutually exclusive body sources:

```bash
sorftime-team product search \
  --data '{"Page":1,"Query":1,"QueryType":"3","Pattern":"example-brand"}'

sorftime-team keyword favorite-change --data-file ./favorite-change.json

printf '%s\n' '{"Keyword":"power bank"}' | \
  sorftime-team keyword get --stdin

sorftime-team --domain us api call ProductQuery --data-file ./request.json
```

Raw input must be a JSON object. `--data-file` and `--stdin` are limited to 25 MiB. Typed flags may be combined with a raw body; typed values overwrite fields with the same exact API key.

合并完成后，typed 与 raw 值统一按同一份 endpoint spec 做类型、枚举、日期、required 非空语义和
wire 编码；例如 `ProductRequest.ASIN` 无论从 typed flag、`--data`、`--data-file`、`--stdin`
还是 `api call` 输入数组，线上 body 都是同一个逗号分隔字符串，空数组一律本地拒绝。

`api call` 接受注册表内大小写不敏感的 endpoint 名和无歧义的 CLI command 名，并直接复用完整
`EndpointSpec`，所以不会丢失 timeout、pagination、parameters、wire 或 `unsafeRetry`。如果一个
command 名在多个 group 中重复（例如 `get`），请使用完整 API endpoint 名；未知端点不允许调用。

## Configuration and precedence

Store only non-secret defaults in the config file:

```bash
sorftime-team config set domain us
sorftime-team config set timeout 120
sorftime-team config set output json
sorftime-team config list
sorftime-team config path
sorftime-team config get domain
sorftime-team config unset output
```

Supported config keys are `domain`, `base-url`, `timeout`, and `output`. Attempts to store a credential through `config set` are rejected.

| Setting | Highest to lowest precedence | Fallback |
|---|---|---|
| Marketplace | `--domain` → `SORFTIME_DOMAIN` → config `domain` | `us` |
| Base URL | `--base-url` → `SORFTIME_BASE_URL` → config `base-url` | `https://standardapi.sorftime.com/api/` |
| Timeout | `--timeout` → `SORFTIME_TIMEOUT` → config `timeout` → endpoint default | 60 seconds |
| Retries | `--retries` → `SORFTIME_RETRIES` | `0` |
| Output | `--output` → `SORFTIME_OUTPUT` → config `output` | `table` on a TTY, otherwise `json` |

`CategoryTree` has a 900-second endpoint default and image search has a 120-second default, unless a higher-precedence timeout overrides it. Valid timeouts are 1–3600 seconds; retry count is 0–5.

The config directory is selected in this order:

1. `SORFTIME_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/sorftime`
3. `~/.config/sorftime`

The canonical API base URL is already configured. Loopback test origins are accepted directly. A remote
proxy also needs its exact HTTPS origin in the deployment-level `SORFTIME_TRUSTED_ORIGINS` allowlist;
setting only `--base-url`, `SORFTIME_BASE_URL`, or config is intentionally insufficient. See [Security](#security).

## Marketplaces and history guardrails

`--domain` accepts the numeric ID, two-letter code, or a listed alias. Use `sorftime-team domains` for the complete mapping.

India, UAE, Australia, Brazil, and Saudi Arabia are documented as not supporting history backfill. History
behavior is part of each endpoint's registry entry rather than a runner-side name table. For those
marketplaces the CLI blocks historical fields on `CategoryRequest`, `ProductRequest`, `AsinSalesVolume`,
`KeywordProductRanking`, and `ASINKeywordRanking`; it always guards the inherently historical
`CategoryTrend` and `KeywordSearchResultTrend`, including when their optional range fields are omitted.

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
sorftime-team --output json --data-only --select 0 product get --asin B000000001

# Select an exact dot-separated path; numeric segments index arrays.
sorftime-team --output yaml --select Data.Items product search \
  --query 1 --query-type 3 --pattern example-brand

# Write through a temporary file and atomically rename it into place.
sorftime-team --output json --output-file ./category-tree.json category tree

# A path of "-" writes to stdout.
sorftime-team --output csv --data-only --output-file - keyword list \
  --pattern '{"RankCondition":[1,1000]}'
```

`--select` is case-sensitive and runs after `--data-only`. A missing path is a validation error.
`--data-only` likewise rejects an envelope with no `Data` field, while preserving present values such as
`null`, `[]`, and numeric `0` as three distinct results. Use JSON or an output file for large responses;
table display is intentionally abbreviated.

Documented list endpoints support bounded automatic pagination:

```bash
sorftime-team --all-pages --max-pages 50 --page-delay 250 \
  --output json --data-only keyword list \
  --pattern '{"RankCondition":[1,1000]}' --page-size 200
```

`--all-pages` starts at the supplied `Page`/`PageIndex` (or 1) and follows the endpoint's explicit
registry `rowPath`; it never chooses among arrays by an English field-name guess. A short non-empty page
is not proof of completion, so pagination continues until an empty array, successful `Data: null`, or the
hard cap. First-page `Data: null` is returned unchanged; it is not rewritten to `[]` or `0`. When retaining
an envelope, `_pagination.maxPagesReached` tells whether a non-empty result hit the cap. `--max-pages`
defaults to 100 and `--page-delay` is milliseconds. Unknown upstream metadata is preserved rather than
reinterpreted; `_pagination.upstreamMetadataFromPage` identifies the source page for those untouched fields.
A missing path or changed page shape fails explicitly.
Exact raw output cannot be combined with pagination.

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

Retries default to zero because every Sorftime endpoint is invoked with POST, including reads. `--retries N`
retries transport failures and HTTP 408/429/5xx responses with exponential backoff. A valid HTTP
`Retry-After` header is honored up to 30 seconds. Sorftime business-envelope codes are a separate layer and
are never retried: in particular, account-global `500`, `501`, and `694` are reported once and execution stops.
Other HTTP 4xx responses are not retried either.

```bash
sorftime-team --retries 2 account coins
```

Only enable retries when duplicate processing is acceptable. If the server completed a request but the response was lost, retrying may consume quota again, start a second task, repeat an update, or repeat a delete. The CLI displays documented cost in command help and `endpoints`, but it does not currently estimate the final bill, prompt for confirmation, or provide a dry-run mode. Allowed request-quota calls execute immediately; a policy-blocked call executes only when every applicable single-call override is present.

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
- Pagination metadata is mostly undocumented. Automatic pagination is therefore limited to endpoints with an explicit registry row path, treats only an empty/null page as the generic terminal signal, and uses `--max-pages` as a hard safety cap. It does not guess from a short page or arbitrary array names.
- Asynchronous APIs use different status lookup keys and incomplete status schemas. Use each family's explicit start, status, and result commands; there is no generic wait/poll command.
- File export/download behavior is not documented. Image search accepts local input, but returned image URLs and AI HTML/Markdown are not downloaded automatically.

- Three parameters the source marks optional are rejected by the API without them (verified live 2026-09-03, business code 10). The CLI now validates them locally: `KeywordQuery.Pattern`, `AIResultQuery.QueryStart`/`QueryEnd`, and `KeywordProductRanking.Month` on the US marketplace.
- `ProductRequest.ASIN` is documented as accepting a batch array, but a JSON array returns `Code 0` with `Data: null` and no charge at any length. Only a comma-separated string works, so the CLI serializes it that way.
- `CategoryTree` is slow and large: measured live on US at 6m33s, 10.4 MB, 35,126 nodes. The endpoint default timeout is 900 s for that reason; always write the result to a file rather than stdout.
- Keyword endpoints accept Amazon Brand Analytics terms only. A non-ABA phrase returns business code 11, which means "not an ABA keyword", not "no search volume".

Consult `sorftime-team <group> <command> --help` and `sorftime-team endpoints --json` for what the CLI can validate locally. Server behavior and billing remain authoritative.

## Security

- 每台装了 CLI 的机器上都有一份 Account-SK。Sorftime 的鉴权只有账号级 Account-SK，**没有按人分发的子令牌**，所以分发一次就等于把账号级凭据复制一份；谁泄漏的无法从上游区分。轮换凭据必须所有人同时换。
- 同样地，配额和限流都是账号全局的，本地 CLI 没有跨机器的用量视图。谁花了多少，只能靠 `sorftime-team account request-stream` 看总量，看不到分人明细。
- Prefer `sorftime-team auth login` or an injected environment secret. Never include a real credential in shell arguments, committed files, logs, test fixtures, or support bundles.
- `--verbose` recursively redacts image bodies, secret-shaped keys, and any occurrence of the actual loaded credential. Non-secret raw fields are still diagnostic output, so do not place unrelated sensitive business data in them when verbose mode is enabled.
- URL userinfo is always rejected. The credential is sent automatically only to the canonical Sorftime origin or loopback (`localhost`, `127.0.0.1`, `[::1]`; HTTP is loopback-only). A remote proxy requires a deployment administrator to set `SORFTIME_TRUSTED_ORIGINS` to its exact HTTPS origin, or the CLI rejects before credential resolution and fetch. The allowlist accepts comma-separated origins only—no paths, queries, fragments, or userinfo.
- Avoid enabling retries for paid or mutating calls unless duplicate execution is safe.
- Keep output files private: product, keyword, review, seller, usage, and AI results may contain commercially sensitive data.
- Credential and config files are written atomically with restrictive permissions; credential files are also checked on every read. Environment variables may still be visible to same-user processes or CI logs depending on the operating system and runner.
- Parsed API response bodies are capped at 100 MiB. This leaves headroom above the measured 10.4 MiB CategoryTree response while bounding memory use.

## 项目结构

```text
.
├── src/cli.ts + src/runner.ts   # 命令表与执行编排
├── src/endpoints.ts             # 全部 52 个端点与参数注册表
├── src/policy.ts                # 穷举计费/共享状态分类与双轴硬闸
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
