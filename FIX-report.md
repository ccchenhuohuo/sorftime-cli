# Sorftime CLI 审核阻断项修复报告

## 结论

`REVIEW-codex.md` 中的 7 个阻断项和 8 个重要项均已按本任务的设计裁决处理。运行时、CLI
discovery、Sorftime Research Skill、用户文档与回归测试已同步。没有修改审核记录，也没有调用
Sorftime API、访问外网、SSH、数据库或执行任何 Git 命令。

策略目录现在仍覆盖 52 个端点，默认开放 41 个；Coin 后果集合 8 个、共享状态写集合 9 个、
重叠 6 个、并集 11 个。重叠端点只给一个 override 时仍然失败关闭。

## 阻断项

### 1. Coin 与共享状态双轴独立、穷举并失败关闭

- `src/policy.ts`：把 `ENDPOINT_EFFECT` 扩展为与 billing 一样的 52 端点穷举目录，新增
  `validateEffectCatalog()`，并在模块加载时同时校验 billing/effect 目录。`effectFor()` 不再把缺项
  默认为 `read`；缺目录的名字在策略隔离测试中按 Coin + write 两轴失败关闭。
- `src/policy.ts`：四个 subscription creator 全部标为 write；`KeywordBatchTaskUpdate` 与
  `ProductSellerTaskUpdate` 按最坏后果同时标为 `recurring_coin` 和 write。`blockedReasons()` 会返回
  所有尚未授权的轴，`assertEndpointAllowed()` 会一次说明缺少哪个或哪两个 flag。
- `src/cli.ts`：帮助与 `endpoints` 文本支持 `COIN+WRITE`，JSON discovery 的 `blocked` 是可同时含
  `coin`、`write` 的数组。
- `README.md`、`AGENTS.md`、`CLAUDE.md`、`docs/cli-skill-integration.md`、
  `skills/sorftime-research/SKILL.md` 及其 reference：统一为 8 Coin / 9 write / 6 overlap / 11 union，
  删除把两类当互斥集合的表述。
- 测试：`test/policy.test.ts` 校验两份目录与 52 个 registry 名精确一致，并对全部 6 个双属性端点
  跑完整 2×2 override 矩阵；`test/runner.test.ts` 和 `test/cli.e2e.test.ts` 继续断言 raw、`api call`
  与 `--all-pages` 路径在配置、凭据和请求之前被拦。

这样修改是因为计费与共享状态是两种独立后果；一次批准花 Coin 不能暗含批准创建团队共享监控，
反之亦然。

### 2. raw body 与 typed body 共用 wire 编码和非空 required 语义

- `src/input.ts`：raw/typed 合并以后，所有 registry 内字段统一再次经过同一个 `coerceValue()`；
  `wire: "csv"` 因此对 `--data`、`--data-file`、`--stdin`、typed flag 和 `api call` 都生效。
- `src/input.ts`：required 的统一空值定义覆盖 `undefined`、`null`、空白字符串和空数组，并在 wire
  转换前后各检查一次。已知字段的 raw `null` 也不再绕过类型契约。
- `src/endpoints.ts`：仍只给 `ProductRequest.ASIN` 声明 CSV wire；`KeywordBatchSubscription.Keyword`
  和 `CoinStream.QueryDate` 保持 JSON 数组，避免扩大实测修复范围。
- 测试：`test/input.test.ts` 覆盖单/多 ASIN、typed、raw JSON、raw file、空数组和空白数组；
  `test/cli.e2e.test.ts` 用本地假服务比较五条公开输入路径的实际 HTTP body，并在四条 raw 路径
  断言空数组本地失败。

### 3. `api call` 只接受 registry 端点并复用完整契约

- `src/cli.ts`：新增 `resolveApiCallEndpoint()`。已知名字返回 registry 中原对象，不再构造
  `parameters: []` 的平行 spec；未知名字直接以 validation error 拒绝，并提示
  `sorftime endpoints`。大小写不敏感的完整端点名和无歧义的已注册 command 名仍可解析。
- `src/runner.ts`：因此 `timeoutMs`、`parameters`、wire、pagination、history 和 `unsafeRetry` 都沿用
  registry；不支持 `--all-pages` 的端点现在还会在解析凭据之前失败。
- `README.md` 与 `skills/sorftime-research/references/cli-contract.md`：删除 future/unregistered
  endpoint escape-hatch 文案，明确 registered-only 契约。
- 测试：`test/runner.test.ts` 断言返回对象身份就是 registry spec、`api call CategoryTree` 的有效
  timeout 为 900000ms、生产 response cap 被传入、不支持分页时不读凭据；
  `test/cli.e2e.test.ts` 覆盖已知端点 required/wire 与未知端点的本地拒绝。

### 4. 取消立即生效且 SIGINT 保留 130

- `src/client.ts`：已取消 signal 在进入请求、每次 attempt、fetch 前后、解析响应前后和 retry wait
  前都会检查；组合 timeout signal 时会立即转发已经发生的 abort。预先取消不会调用 fetch。
- `src/runner.ts`：在配置后、body 后、凭据前后、每次分页迭代与页间 delay（包括 0ms）前后检查
  signal。
- `src/input.ts`：文件和图片读取前后检查 signal，并把 signal 传给可取消的 `readFile`；stdin
  改为带 abort listener 的有界读取，取消时清理 listener 并停止等待输入。
- `src/cli.ts`：若根 signal 已被 SIGINT 取消，catch 不再用一般 NetworkError 的退出码覆盖 130。
- 测试：`test/client.test.ts` 覆盖 pre-abort fetch=0 和 retry wait 中取消；
  `test/runner.test.ts` 覆盖入口 pre-abort、body 构建中取消、页间取消；
  `test/cli.e2e.test.ts` 包含真实子进程 SIGINT=130 回归。

### 5. 业务码 500/501/694 永不重试

- `src/types.ts`、`src/service.ts`、`src/runner.ts`、`src/client.ts`：完整删除
  `retryApiThrottle` 这条平行机制。HTTP 成功响应里的任何非零业务码立即抛 `ApiError`，不进入
  transport retry。
- `README.md` 与 Skill CLI contract：明确业务 envelope 和 HTTP transport 是不同层；500、501、
  694 报告一次后停止。
- 测试：删除原先保护 501 重发的相反断言；`test/client.test.ts` 对 500/501/694 在 `retries=5`
  时逐个断言只 fetch 一次，同时分别保留 HTTP 408/429/503 会重试的测试。

这项按 `AGENTS.md` 不变量 9 执行，没有采纳任何允许 501 自动重试的解释。

### 6. Account-SK 的可信目的地边界

- `src/client.ts`：新增 `validateCredentialDestination()`。拒绝 URL userinfo、query、fragment；按 URL
  解析后的 origin 精确比较；只自动信任 canonical Sorftime origin 和 loopback
  (`localhost`、`127.0.0.1`、`[::1]`)。HTTP 仅允许 loopback。
- 远程代理 opt-in 选择部署级环境变量 `SORFTIME_TRUSTED_ORIGINS`，内容只能是逗号分隔的精确
  HTTPS origin，不能带 path/query/fragment/userinfo，端口也必须匹配。没有增加普通查询可顺手
  携带的 flag；这是选择部署变量而不是单次 flag 的原因。
- `src/runner.ts`：在构建 body、解析 Account-SK 和创建客户端之前验证目标；`src/client.ts` 在真正
  fetch 前再次验证。`src/cli.ts` 的 config 输入也拒绝 userinfo/query/fragment。
- `README.md`、`docs/deployment.md`、Skill CLI contract 与 `AGENTS.md`：记录部署方式与新的安全
  不变量。
- 测试：`test/client.test.ts` 覆盖 canonical、IPv4/IPv6 loopback、远程精确 origin opt-in、端口
  不匹配、userinfo、未授权 remote fetch=0；`test/runner.test.ts` 断言未授权 remote 在凭据解析和
  client 创建前失败。

### 7. `--all-pages` 正确保留成功的 `Data:null`

- `src/runner.ts`：首页 `Code:0 + Data:null` 作为零行终止页直接原样返回；后续页的 `Data:null`
  终止聚合但保留之前的 rows；空数组仍是空列表终止页。代码没有把 null 改写成 0 或 `[]`。
- `src/output.ts`：`--data-only` 对 present `null`、`[]`、`0` 保持三种不同值。
- 测试：`test/runner.test.ts` 覆盖首页 null、非空页后 null、空数组、显式 row path；
  `test/output.test.ts` 覆盖 null/[]/0；`test/client.test.ts` 覆盖业务 code 10/11 仍抛业务错误，
  `test/runner.test.ts` 覆盖策略拒绝仍是本地错误。

## 重要项

### 1. `--verbose` 与错误文本递归脱敏

- `src/client.ts`：按 secret-like key 递归遍历对象和数组，遮蔽 Authorization、token、secret、
  password、Account-SK、API key、Image，并遮蔽任意字符串里出现的实际已加载 token。业务消息、
  HTTP status text 和 fetch exception 也在形成用户错误前替换 token。
- `src/input.ts`、`src/config.ts`：JSON parse error 不再拼接运行时 parser 原文，避免不同 Node
  版本把包含误贴凭据的输入片段反射到 stderr。
- 测试：`test/client.test.ts` 覆盖嵌套字段、数组、Image、实际 token、URL userinfo 和上游错误；
  `test/input.test.ts`、`test/config.test.ts` 覆盖 malformed JSON 不回显 sentinel。

### 2. 实测必填进入 registry，同一真相驱动帮助、发现与校验

- `src/types.ts`、`src/endpoints.ts`：增加 `sourceOptionalButRuntimeRequired` 与 registry 级
  `requiredWhen`。`KeywordQuery.Pattern`、`AIResultQuery.QueryStart/QueryEnd` 都是有效
  `required:true`；`KeywordProductRanking.Month` 是 US 条件必填。
- `src/input.ts`：删除对应的 endpoint-name 必填分支，改为通用 registry 校验；增加通用日期区间
  顺序校验，并对 AI history 强制最多 7 个日历日。
- `src/cli.ts`：help 同时展示 required、runtime-verified 和 marketplace 条件；
  `endpoints --json` 自然输出同一 metadata。
- `skills/sorftime-research/references/workflows.md`：`agent status --method 0` 补齐 start/end；
  `README.md` 的两个 `keyword list` 示例均补 `--pattern`。
- 测试：`test/endpoints.test.ts` 校验 registry metadata；`test/input.test.ts` 覆盖 typed/raw null、
  条件必填、日期逆序和 7 日边界；`test/cli.e2e.test.ts` 检查真实 help 文本。

### 3. 分页不再猜数组或把短页当结束

- `src/types.ts`、`src/endpoints.ts`：每个可自动分页端点显式登记 `rowPath` 与
  `termination: "empty-page"`；`CategoryProducts` 使用 `Data.Products`，其他已登记端点使用
  `Data`。运行时不维护英文候选字段列表。
- `src/runner.ts`：只按登记路径做大小写不敏感定位；缺路径、形状改变或多数组但没有所需路径时
  明确失败。非空短页继续请求，只有空数组、成功的 `Data:null` 或 hard cap 终止。
- 聚合保留首屏未知 metadata，不猜它的含义；附加 `_pagination.upstreamMetadataFromPage` 标明这些
  未改写字段来自哪一页，`maxPagesReached` 明示是否在非空页触顶。
- 测试：`test/runner.test.ts` 覆盖 `Data.Products`、Data 裸数组、root array、多数组歧义、shape
  drift、短页后仍有数据和 max cap；`test/cli.e2e.test.ts` 用本地服务验证短页不会提前停止。

### 4. history guard 由 registry 驱动

- `src/types.ts`、`src/endpoints.ts`：新增 `history.mode = always | when-fields-present`；七个历史端点
  在 registry 登记。`CategoryTrend` 与 `KeywordSearchResultTrend` 是 `always`，后者省略默认日期
  也不会绕过不支持站点的 guard。
- `src/runner.ts`：删除 `HISTORY_FIELDS` 第二张端点表，只消费 endpoint metadata。
- `README.md` 与 discovery 文档：列全七个端点并解释触发方式。
- 测试：`test/endpoints.test.ts` 校验 metadata；`test/runner.test.ts` 断言 IN 上省略日期的
  `KeywordSearchResultTrend` 在读凭据前仍被拦。

### 5. Skill 成本规则统一

- `skills/sorftime-research/SKILL.md`、`references/interpretation-boundaries.md`、
  `references/workflows.md` 与 `agents/openai.yaml`：统一为先查 CLI billing；free 明示 0；任何
  request/coin/recurring_coin/unknown 调用都要先报告 endpoint、marketplace、估算成本并取得同意；
  workflow 另确认总成本。删除“every call spends”和“少量可免确认”的冲突表述。
- eval 2、4、10 等同步要求 marketplace 澄清、逐调用成本同意和分页 cap 总成本同意。
- 测试：`test/skill-contract.test.ts` 对统一规则作语义断言。

### 6. Skill contract 改为语义门禁

- `test/skill-contract.test.ts`：解析 blocked 表，逐端点对照 policy 的 blocked kind、完整所需 flag
  与真实 `group command`；扫描可执行示例，禁止主动携带 override。
- 同一测试解析 curated route 表，并对照 `createProgram()`、registry 的命令、存在的 flag、必填
  flag 和逐字 cost；不再只验证某个词是否在任意文件出现。
- `skills/sorftime-research/evals/evals.json`：修正 marketplace 默认猜测和首页推断总页数等错误；
  测试逐条 lint 12 个 `expected_output` 的安全语义。
- `docs/cli-skill-integration.md`：说明现在实际校验的语义边界。

### 7. 补齐执行级测试空洞

- 新增 `test/runner.test.ts`，通过依赖注入验证 policy/config/token/client 的真实调用顺序、完整
  registry spec、history、分页与取消，不依赖网络。
- 扩充 `test/cli.e2e.test.ts`：五输入路径真实 body、四 raw 空值、registered-only API、双轴 raw/
  api/all-pages、短页分页、unsafe retry、raw bytes 和 SIGINT。
- 扩充 client/input/config/output/policy/endpoint 测试，覆盖本报告各边界。
- 当前共有 133 个测试；此沙箱实际通过 130 个，剩余 3 个均在建立本地监听器时被环境以
  `listen EPERM 127.0.0.1` 拒绝，尚未进入产品断言。没有删除、skip 或弱化这三项。

### 8. 凭据文件读取强制可信权限

- `src/config.ts`：读取前用 `lstat`，拒绝 symlink、非普通文件、POSIX group/other 任意权限和非
  当前用户 owner；然后才解析内容。错误只给路径与 `chmod 600` 修复提示，不含值。
- `README.md`、`docs/deployment.md` 与 Skill CLI contract：从“写入时 0600”更新为“每次读取都
  验证 0600/owner/regular-file/no-symlink”。
- 测试：`test/config.test.ts` 覆盖 0600 接受、0644 拒绝且不泄值、symlink 拒绝、malformed
  credential JSON 不回显内容。

## 次要项与文档漂移

已完成任务点名的三个文档修复：

- `README.md` 的 CategoryTree 全部统一为 900 秒；
- 项目树从不存在的 `src/billing.ts` 改为实际的 `src/policy.ts`；
- `docs/deployment.md` 把 `BLOCKED` 列改为真实的 `STATUS`，并说明 `COIN+WRITE`。

其余次要项也一并处理：

- `src/output.ts`：`--data-only` 遇到缺失 Data 明确报错，present null/[]/0 不混淆；
- `src/endpoints.ts` / `src/input.ts`：删除未证实的 review collection `OnlyPurchase=0`，落实
  ProductQuery `QueryType=1..16`，并对已登记日期对做顺序校验；
- `src/types.ts`、`src/config.ts`、`src/service.ts`：删除不存在 CLI surface 的 token/flag 类型、
  未使用的 config 更新函数和 `retryApiThrottle`；
- `src/types.ts`：用一个 `OUTPUT_FORMATS` 常量驱动类型、CLI 和 config 校验；
- `src/client.ts`：修正 `[::1]` loopback，并在生产 runner 设 100 MiB response-size 上限；
- README 与部署文档删除不存在的 `--token`，记录上限和 IPv6 行为。

## 不同意或没有修的部分

- 对 7 个阻断项和 8 个重要项的事实判断没有异议；阻断 5 明确以 `AGENTS.md` 不变量 9 为准，
  所以没有保留任何业务码 501 重试开关。
- 对重要项 3 的“分页后 metadata 可能不一致”，同意风险，但没有猜测或重算 upstream 的
  `total/page` 等未知字段。选择原样保留首屏 metadata，并用
  `_pagination.upstreamMetadataFromPage` 标来源；这是为了遵守不变量 8，而不是把未知含义编成
  客户端语义。
- 没有进一步硬编码资料中边界定义不完整的日期跨度（例如“最多 2 年”究竟按日、月还是站点
  数据可用期判断）以及会随日期/站点变化的 earliest/latest 限制。已落实格式、先后顺序和实测
  明确的 AI 7 日限制；其余继续由上游判定，避免本地误拒。这属于报告中的次要契约增强，不是
  阻断项或重要项残留。
- 没有执行真实 API/live check。任务硬性禁止任何 Sorftime API 和外网访问，因此真实 response
  shape、计费与 IP allowlist 仍只沿用仓库已有的实测记录。

## 最终验证

执行日期：2026-09-03（Asia/Shanghai）。

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 非监听测试集：9 个文件、126 个测试全部通过。
- `pnpm check`：typecheck 与 lint 通过；测试阶段 133 个中 130 个通过，3 个失败均为沙箱禁止
  `127.0.0.1` 监听的 `listen EPERM`，因此命令以 1 结束并按脚本短路，未在该次调用内进入 build。
- 单独 `pnpm build`：通过；ESM bundle 与 DTS 均成功生成。
- Skill quick validator：`Skill is valid!`。
- `pnpm exec vitest run test/skill-contract.test.ts`：1 个文件、6 个测试全部通过。

三项 `listen EPERM` 分别是五路径 HTTP body、短页分页、raw/SIGINT 本地服务 E2E；它们仍保留为
正常环境下的验收测试。该环境现象与上一轮审核记录和任务提醒一致，没有通过删除或 skip 测试规避。
