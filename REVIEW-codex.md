## 结论

不通过：CLI-only + Skill 的收敛方向正确，但双策略闸、raw/API escape hatch、取消/重试、凭据目的地主机和空结果分页仍有可导致越权写入、持续 Coin 消耗、凭据外送或付费结果误判的阻断缺陷，修复前不应发布。

## 阻断项

### 1. 两个 override 对“同时花 Coin 且改共享状态”的端点并不独立

- **文件:行号**：`src/policy.ts:96-106,155-172`；`src/endpoints.ts:228-238,267-275,300-307,326-330`；`test/policy.test.ts:93-102`。
- **问题**：`KeywordBatchSubscription`、`BestSellerListSubscription`、`ProductSellerSubscription`、`ASINSubscription` 明确创建或修改共享监控/订阅，也会持续或按更新消耗 Coin，但它们不在 `ENDPOINT_EFFECT` 中，因而 `effectFor()` 默认返回 `read`。本地求值可复现：对这四个端点调用 `blockedReason(name, { allowCoin: true })` 均得到 `undefined`；CLI 路径随后会进入 `SorftimeCoreClient.call()`。也就是说，`--allow-coin` 实际兼任了 `--allow-write`。反向也需要重新审计：`KeywordBatchTaskUpdate` 的 `Update=2` 可启动付费关键词监控，当前却以 `billing=free` 被 `--allow-write` 单独放行；请求体未公开的 `ProductSellerTaskUpdate` 更应失败关闭，而不是假定不会改变后续 Coin 消耗。
- **为什么阻断**：这直接违反两个单次授权“互不越权”的要求；一次只同意花 Coin 的操作可以创建长期共享状态并持续扣费。现有测试只拿纯写端点 `BestSellerListDelete` 和纯 Coin 端点 `ProductReviewsCollection` 交叉测试，还反向固化“恰好五个 write”，没有覆盖重叠集合。
- **建议修法**：把“本次调用计费”“产生/改变共享状态”“启动/改变后续持续计费”建成真正独立的轴。至少将四个 subscription creator 标成 `write`；对能启动/扩容付费监控的 update 端点按失败关闭要求同时需要 Coin 授权。effect 也不应以“未登记即 read”失败开放，应像 billing 一样穷举校验。`assertEndpointAllowed()` 对同时命中两轴的调用必须要求两个 flag，并增加所有双属性端点的 2×2 override 矩阵测试；同步更正“6 Coin + 5 write”这种误导性的互斥计数。

### 2. `ProductRequest.ASIN` 的 CSV 修复只覆盖 typed flag，raw body 仍会发送已知无效的数组

- **文件:行号**：`src/endpoints.ts:55-65`；`src/input.ts:173-195,215-223`；`test/input.test.ts:13-31,202-212`。
- **问题**：`wire: "csv"` 只在 typed option 经过 `coerceValue()` 时生效。raw body 合并后，第二轮只重新处理 number/integer 和 string，完全跳过 `string[]`。本地可复现：`buildRequestBody(ProductRequest, { data: '{"ASIN":["B000TEST01","B000TEST02"]}' })` 返回 `{"ASIN":[...]}`，而 typed 输入返回 `{"ASIN":"B000TEST01,B000TEST02"}`；`{"ASIN":[]}` 也通过 required 检查。`--data-file`、`--stdin` 和 `api call ProductRequest` 同样受影响。
- **为什么阻断**：仓库自己的实测注释及任务背景均说明数组会得到 `Code:0 + Data:null`。这不是显式报错，而是会被解释成“成功但无数据”，正好重现本次重构声称已修复的历史故障；最常用端点仍有一条公开输入路径会静默给出错误结论。
- **建议修法**：在 raw/typed 合并完成后统一按最终 `EndpointSpec` 做 wire encoding 和非空校验；只对声明了 `wire:"csv"` 的参数 join，其他 `string[]`（`KeywordBatchSubscription.Keyword`、`CoinStream.QueryDate`）继续保持 JSON 数组。增加 typed command、typed command + 三种 raw source、`api call ProductRequest`、单值/多值/空数组的端到端请求体测试。

### 3. `api call` 为已知端点构造了一个丢失契约的假 `EndpointSpec`，对未知端点的文档承诺又不可实现

- **文件:行号**：`src/cli.ts:189-208`；`src/runner.ts:130-136,186-201`；`src/service.ts:31-37`；`src/endpoints.ts:21-28`；`README.md:171-177`；`skills/sorftime-research/references/cli-contract.md:52-54`。
- **问题**：即使 `findEndpoint()` 找到已知端点，`api call` 仍重建 `parameters: []` 的对象，且不复制 `timeoutMs`、`pagination` 等字段。因此它绕过已知 required/type/wire 校验，拒绝本应支持的 `--all-pages`，并让实测需 900 秒的 `CategoryTree` 回落到 60 秒；一次 5-request 调用很可能超时而上游仍继续工作。另一方面，未知名在无 `--allow-coin` 时确实被策略拦下，但即使显式放行，也会在 `service.ts` 再次查注册表并报 `Unknown Sorftime endpoint`，所以 README 所称“future endpoint”根本不能调用。
- **为什么阻断**：任务特别要求核验的 raw escape hatch 不是同一确定性执行核心：已知端点丢契约并可能浪费付费配额，未知端点则与公开契约相反。该平行构造也会在新增端点字段时继续漏同步。
- **建议修法**：已知端点直接传完整 registry spec，不要重建。对未知端点二选一并写清：若坚持“52 个注册端点是唯一可执行集合”，就在 `api call` 入口明确拒绝未知名并删除 future/unknown-override 文案；若确需未来端点 escape hatch，则需一个经过显式 Coin 授权、合法 endpoint 名检查且不会在 service 再拒绝的单一实现，并因 effect 同样未知而失败关闭，不能沿用 `effectFor(unknown)="read"`。两种设计都应有 CLI 级测试，并验证 known endpoint 的 timeout、required、wire、pagination 不丢失。

### 4. 已经取消的 signal 不会中止请求，SIGINT 可能在取消后仍发出付费调用

- **文件:行号**：`src/client.ts:84-96,142-153,167-181`；`src/runner.ts:106-118,144-149`；`src/cli.ts:254-271`。
- **问题**：`timeoutSignal()` 和 `pageDelay()` 只注册未来的 `abort` 事件，没有处理传入 signal 已经 `aborted` 的情况。静态注入 fake fetch 可复现：先 `controller.abort()`，再调用 `requestApi(..., signal, fakeFetch)`，fake fetch 仍被调用 1 次，收到的内部 signal 为 `aborted=false`。若 SIGINT 发生在配置解析、读 raw 文件/图片或两页之间，后续请求仍可能发出。另一个结果是 handler 先设 exit 130，`runCli()` 捕获 `NetworkError` 后又会把退出码覆盖为 4，README 的 SIGINT=130 契约也不可靠。
- **为什么阻断**：取消是阻止后续共享配额消费的最后一道运行时护栏；当前实现可能在用户明确中止后继续发送第一页或下一页。
- **建议修法**：组合 signal 时先检查 `parent.aborted` 并立即 abort/throw；每次请求、每次 retry、每次分页迭代前调用等价于 `signal.throwIfAborted()` 的检查，delay 为 0 也不能跳过。SIGINT 后保留 130。增加 pre-aborted、构建 body 期间 abort、页间 abort、retry wait 期间 abort 和真实子进程 SIGINT 测试，断言 fetch 调用次数。

### 5. CLI 显式把业务码 501 纳入重试，违反“500/501/694 报告并停止”的硬规则

- **文件:行号**：`src/runner.ts:191-218`；`src/client.ts:199-206`；`test/client.test.ts:63-73`；`README.md:345-355`；`skills/sorftime-research/references/cli-contract.md:89-94`。
- **问题**：只要 `--retries > 0`，runner 就设置 `retryApiThrottle:true`；收到业务 `Code=501` 后 client 等待并再次发送。测试明确要求第二次 fetch 成功，README 也宣传会重试 501；这与 AGENTS 不变量及 Skill 的“账户全局限流，停止而非重试”直接冲突。
- **为什么阻断**：501 可能由同事造成，自动重发会加剧账户级限流，并可能重复付费或重复创建任务；“默认 0”不能抵消显式实现了被禁止行为这一事实。
- **建议修法**：业务码 500/501/694 无条件抛出 `ApiError`，不要受通用 transport retry 开关控制；移除 `retryApiThrottle` 这条平行机制及相反测试。HTTP 408/429/5xx 与业务 envelope code 要继续分开讨论和测试。

### 6. 任意 HTTPS `base-url` 都会收到完整 Account-SK，当前只有文档提醒，没有可信目的地边界

- **文件:行号**：`src/cli.ts:68-75,220-236`；`src/runner.ts:39-50,186-209`；`src/client.ts:160-180`；`README.md:388-397`。
- **问题**：flag、环境变量或配置可以把 base URL 指向任意 HTTPS origin；校验只看 scheme，随后无条件附加 `Authorization: BasicAuth <Account-SK>`。用 fake fetch 可复现 `baseUrl=https://collector.example/api/` 时目标 URL 指向该主机且 Authorization 完整存在。HTTPS 只保证与“所选主机”加密通信，并不证明该主机是 Sorftime 或受信代理。对于会由 Skill/Host 组装命令、且全员共用同一把不可分人吊销凭据的 CLI，README 警告不足以构成护栏。
- **为什么阻断**：一条被误导生成的 `--base-url` 或被污染的 config 即可把团队 Account-SK 主动发送给第三方，后果是全员轮换和无法追责。
- **建议修法**：生产默认将 credential 绑定到 canonical origin；远程代理必须来自独立的受信 allowlist/部署配置并有不可被普通查询提示词顺手开启的确认边界。至少拒绝 URL userinfo、明确比较 origin、区分 localhost 测试和远程代理；为 canonical、localhost、未授权远程 origin 写请求前断言测试。

### 7. `--all-pages` 把成功的 `Code:0 + Data:null` 改判成本地错误

- **文件:行号**：`src/runner.ts:69-87,144-162`；`skills/sorftime-research/references/interpretation-boundaries.md:24-35`。
- **问题**：client 正确把 `Code=0` 当成功，但 `locateRows()` 对 `Data:null` 返回 `undefined`，`requestAllPages()` 随即抛出 “Could not identify a result array” 并以 validation error 结束。相同响应在不分页时会正常输出 `null`；是否加 `--all-pages` 改变了业务语义。
- **为什么阻断**：这违反“成功无数据、业务错误、策略拦截必须区分”的核心口径；调用者会把真实的成功空结果误报为客户端/响应 schema 故障，并且第一笔请求已经消耗配额。
- **建议修法**：对确认成功的 envelope 将 `Data:null` 作为零行终止页处理，同时原样保留首个 envelope 和 `Data:null` 的语义（不要改写成数值 0）；为空数组仍按空列表处理。增加第一页 null、满页后 null、空数组、code 10、code 11 和本地 policy block 的分层测试。

## 重要项

### 1. `--verbose` 的“永不打印凭据”保证只遮了顶层 `Image`

- **文件:行号**：`src/client.ts:64-72,163-165`；`test/client.test.ts:75-83`；`README.md:392-394`。
- **问题**：raw body 中的 `Authorization`、`token`、`accountSk`、`secret` 等字段及嵌套对象会原样写到 stderr。本地 fake-fetch 复现 `{Authorization:"BasicAuth sentinel-account-sk", nested:{accountSk:"sentinel-account-sk"}}` 时日志包含两次 sentinel。现有测试只验证 Image 和 header token 未出现。
- **为什么重要**：虽然正常 Sorftime 调用不把 Account-SK 放进 body，但 raw/future/代理用法正是最容易误放凭据的路径；文档的绝对保证与实现不符。
- **建议修法**：按与 config 相同或更完整的 secret-key 规则递归遮蔽对象/数组，并对已解析 URL 的 userinfo、错误文本和嵌套字段加测试；若无法给绝对保证，文档也必须收窄措辞。

### 2. 三条“实测必填”规则放在第二套 endpoint-name 分支里，导致帮助/发现结果撒谎且 raw 值仍可绕过

- **文件:行号**：`src/endpoints.ts:145-150,184-190,354-362`；`src/input.ts:183-213`；`skills/sorftime-research/references/workflows.md:79-85,142-147`；`README.md:299-325`。
- **问题**：`KeywordQuery.Pattern`、`AIResultQuery.QueryStart/QueryEnd` 在 registry 中仍非 required，所以 `--help` 和 `endpoints --json` 不显示真实有效契约；Skill 的 Agent workflow 仍给出必然被本地拒绝的 `agent status --method 0`，README 的两个 `keyword list` 示例也都缺 `--pattern`。此外校验只判断 `undefined`，raw 的 `Pattern:null`、日期 `null`、required `string[]:[]` 仍可通过；AI 日期还没有校验 `start<=end` 和最多 7 天。
- **为什么重要**：CLI 自称 discovery 输出是权威来源，但用户按权威 help/Skill 复制命令会失败；付费端点的校验覆盖也因输入模式而不同。
- **建议修法**：无条件实测必填应成为 registry 的有效契约（可附 `sourceOptionalButRuntimeRequired` 注释/元数据），让 help、JSON、校验共用；`Month` 的 US 条件判断保留为清晰的条件约束并在 help 表达。统一定义 required 的非空语义，并补日期区间测试。当前 runner 传入规范化 `domain.code`，所以 US-only 判断本身是正确的。

### 3. 分页通过字段名优先表猜数组，并以“短于最大/默认页长”推断结束，证据不足时可能静默截断

- **文件:行号**：`src/runner.ts:69-102,130-162`；`src/endpoints.ts:39-43,78-84,176-206`；`README.md:318-325,376-377`。
- **问题**：当 `Data` 是对象时，代码从 `items/list/rows/records/results/products/keywords` 中猜第一条数组；若有多个数组，可能聚合错误字段而不是失败。对只有 `Page` 的多个端点，registry 的 `defaultPageSize=100/200` 来自文档的“每页最多”而不总是明确的固定 page size；短页不必然证明没有下一页。聚合还保留首屏对象中的其他分页元数据，可能与合并后的 rows 不一致。
- **为什么重要**：这是对未知响应 schema 的语义猜测，可能比显式失败更危险；`--max-pages` 确实限制了循环次数，但不能防止提前停止或合并错数组。
- **建议修法**：只为实测确认过的端点在 pagination spec 中登记明确 `rowPath` 和可靠终止信号（total/hasNext/固定 page size）；多数组或页形状变化时失败，不要按通用英文名猜。为 `Data.Products`、`Data` 裸数组、root array、多数组歧义、页形状变化、短页仍有下一页和 `maxPagesReached` 加测试。

### 4. history guard 是 runner 中的第二份端点表，且实现与 README 已脱节

- **文件:行号**：`src/runner.ts:12-20,53-55,178-184`；`README.md:278-284`。
- **问题**：代码对 `CategoryTrend` 永远判 history，并登记了 7 个端点；README 只说 5 个且漏掉 `CategoryTrend`、`KeywordSearchResultTrend`。更实质地，`KeywordSearchResultTrend` 只在显式传 QueryStart/QueryEnd 时被挡，但其文档默认本身就是历史区间；在不支持 backfill 的站点省略日期会绕过 guard 并可能浪费 10 requests。
- **为什么重要**：用户不能从权威 discovery/README 判断 `--force` 行为，且昂贵历史调用的保护依赖另一个易漂移的手工名字表。
- **建议修法**：把 history capability/trigger 收回 endpoint registry（支持 `always`、字段触发、默认即历史等明确模式），由 runner 和 discovery 共用；按各端点真实站点能力补测试并同步文档。

### 5. Skill 的成本规则彼此冲突，且把免费读取说成“每次都花 request”

- **文件:行号**：`skills/sorftime-research/SKILL.md:3,8-9,33-50,87-89`；`skills/sorftime-research/references/interpretation-boundaries.md:60-66`。
- **问题**：frontmatter 和正文称 every call/data call 都花共享 request，但同一 Skill 又正确说明 monitor/account 的多条读取免费；正文只要求“超过少量 requests”确认，而 interpretation reference 要求每条命令先报成本且未同意就停止。Host 首先看到的规则无法得出唯一执行策略。
- **为什么重要**：轻则对免费查询制造不必要阻塞，重则把 1–2 request 的调用当成无需用户确认，违背 Skill 的职责边界。
- **建议修法**：统一成“每次先从 CLI 确认 billing；free 明示为 0，所有非 free 调用在执行前报告 endpoint/marketplace/预计成本并取得同意；批量另做总成本确认”，删除“every call spends”和“more than a few”的歧义。

### 6. Skill contract 门禁只检查任意文本包含，无法防止危险语义和路由参数/成本漂移

- **文件:行号**：`test/skill-contract.test.ts:39-68,71-85`；`docs/cli-skill-integration.md:23-34`；`skills/sorftime-research/evals/evals.json:4-15`。
- **问题**：被拦端点只需在 SKILL、任一 reference 或 agent YAML 的任意上下文出现一次即可通过，即使文本是在鼓励执行；没有断言对应 blocked kind、所需 flag 或“不得主动放行”。路由表的 flag、required 条件、成本数字均未对 registry/policy 校验。所谓 eval 测试只数 12 条、查 ID/prompt 唯一和绝对路径，完全不验证 `expected_output`；例如 eval 4 在未给 marketplace 时直接假定 US，违背“站点不明显就问”，eval 10 要从第一页“推断页数”，但响应未必提供总数，内容错误仍全绿。
- **为什么重要**：当前门禁能证明文件里“出现过某些词”，不能证明 Skill 会安全路由；此次已存在的 `agent status` 漂移就是实例。
- **建议修法**：为 curated route 行解析出 command/flags 并与 `createProgram()`/registry 对照；对 blocked 表逐行验证命令、kind、禁止主动传 override 的语境；对成本建立少量可计算断言。真正运行 Skill eval 或至少逐条 lint expected behavior 与核心不变量，不能把“JSON 有 12 项”称为行为门禁。

### 7. 90 个测试在 runner/policy 集成、raw escape、取消和真实分页形状上有实质空洞

- **文件:行号**：`test/cli.e2e.test.ts:37-137`；`test/input.test.ts:13-31`；`test/policy.test.ts:63-103`；`test/output.test.ts:1-22`。
- **问题**：没有 `runner.test.ts`；policy 测试只调纯函数，未证明 block 位于凭据解析和 fetch 前，也未覆盖 raw/api/all-pages。CLI E2E 只有 Data 裸数组的短页示例，没有 `Data.Products`、null、root array、max cap、shape drift。ProductRequest 回归只直接测 typed `buildRequestBody`，没有 raw source 或真正的 CLI batch parse。没有 pre-aborted/中途取消、custom origin、递归日志脱敏、credential-file mode、SIGINT exit 测试。501 测试反而固化了禁止行为。
- **为什么重要**：最昂贵和最不可逆的边界恰好没有执行级回归；“90 个测试全绿”不能支持发布判断。另有不少 endpoint 测试只是把文档清单复制成期望值，证明本地两份文本一致，不证明上游真实契约；实测异常需要可追溯 fixture/记录说明来源。
- **建议修法**：优先补 runner 注入式测试（config/token/fetch spy）和 CLI localhost E2E，逐一断言“拦截时零凭据读取、零 fetch”、双属性授权矩阵、raw/API call 契约、分页全部真实形状、取消与输出语义。保留文档清单测试，但不要把它当 API 行为证明。

### 8. 读取凭据文件时不检查 0600，安全保证只在写入那一刻成立

- **文件:行号**：`src/config.ts:69-75,124-150`；`test/config.test.ts:14-36`。
- **问题**：`saveToken()` 会 chmod 0600，但 `readFileToken()` 对现有 `credentials.json` 不做 mode/owner 检查；一个被复制、解压或手工创建成 0644 的文件仍会被静默接受。测试只验证本程序刚写出的模式。
- **为什么重要**：AGENTS 和文档把“mode-0600 file”列为允许的凭据来源，当前实际条件却只是“路径上有 JSON”；多人机器或备份恢复后可能长期暴露账号级密钥。
- **建议修法**：在支持 POSIX mode 的平台读取前 `stat`，拒绝 group/other 任意权限并给不含值的修复提示；同时检查不是目录、按需要防符号链接/owner 异常。补 0600 接受、0644 拒绝和错误不泄值测试。

## 次要项

- `src/output.ts:98-109`：`--data-only` 在 envelope 完全没有 Data 字段时悄悄回退输出整个 envelope；这虽没有把 missing 变成 0，但与选项名称不符。建议缺字段时报明确错误，`Data:null` 仍输出 `null`。
- `src/endpoints.ts:106-113`：`ProductReviewsCollection.OnlyPurchase` 的参考摘要只明确 `1`，实现自行接受 `0`；该端点虽默认 Coin-blocked，仍应删除未验证枚举或记录实测依据。`ProductQuery.QueryType` 的 1–16 和多处日期先后/跨度也只写在描述、未校验。
- `src/types.ts:70-77`、`src/config.ts:85-94,129-141`、`src/service.ts:8-13`：`GlobalOptions.token`/`TokenSource="flag"` 没有 CLI flag，`updateConfig()` 未使用，`maxResponseBytes` 在生产 runner 从不赋值。它们是重构后遗留的死表面；其中 token 路径还让 `docs/deployment.md:40` 错称支持 `--token`。建议删除而不是保留“以后也许用”。
- `src/runner.ts:11`、`src/config.ts:36`、`src/cli.ts:82-84,228`：输出格式集合维护了至少四份（还包括 `OutputFormat` union）；抽成一个只读常量即可，避免新格式半同步。
- `README.md:268,405`：CategoryTree 一处仍写 300 秒而有效值和后文均为 900 秒，项目树仍写不存在的 `src/billing.ts`；`docs/deployment.md:57` 又把实际 `STATUS` 列写成 `BLOCKED`。这些是可直接修掉的残留。
- `src/runner.ts:46-48` 与 `README.md:394`：Node 的 IPv6 hostname 是 `"[::1]"`，当前 allowlist 写 `"::1"`，所以文档声称允许的 IPv6 loopback HTTP 实际会被拒绝。
- `src/client.ts:99-130`、`src/service.ts:8-13`：response-size 限制实现存在，但 runner 不提供默认值或配置，生产调用实际无上限；要么设与 CategoryTree 大响应兼容的明确上限，要么删去“已处理响应体积”的暗示。

## 误报澄清

- **没有发现受支持 CLI 路径绕过 `assertEndpointAllowed()` 发网请求。** 唯一 fetch 在 `src/client.ts:170`；两个 CLI action 都进入 `runEndpoint()`，而 `src/runner.ts:171` 在 `loadConfig()`（172）和 `resolveToken()`（173）之前执行策略断言。typed/raw body 尚未构建，分页 closure 也尚未创建，所以 `--data`、`--data-file`、`--stdin` 和 `--all-pages` 不能改变 endpoint 或提前发网。直接 import 内部 `requestApi`/`SorftimeCoreClient` 不属于 package 声明的 CLI surface；若未来发布为库，才需要把 policy 下沉。
- **注册表缺项确实失败关闭。** `blockedReason()` 用 `ENDPOINT_BILLING[name] ?? "unknown"`，无 `--allow-coin` 时会在凭据前拒绝。即便传了 flag，当前 service 还会拒绝未知端点；后者是阻断项 3 的契约不一致，不是放行漏洞。
- **纯 Coin 与纯 write 样本的 flag 确实互不越权。** `--allow-write` 不能放行 `ProductReviewsCollection`，`--allow-coin` 不能放行 `BestSellerListDelete`；真正的问题是 policy 没给兼具两种后果的订阅端点建重叠分类。
- **typed flag 的 wire 大小写和数组编码正确。** registry 保留 `ASIN`/`Asin`/`Asins`/`Querystartdt`，最终 body 不做 key normalization；`wire:"csv"` 仅标在 ProductRequest，因此 typed 的 `KeywordBatchSubscription.Keyword`、`CoinStream.QueryDate` 仍是数组。缺陷只在 final raw-body 处理没有应用同一 wire contract。
- **非分页输出没有把 null、空数组或数值 0 混成一类。** client 对 code 10/11 抛 `ApiError`，本地策略抛 `ValidationError`；`prepareOutput(...,{dataOnly:true})` 对 `Data:null` 输出 `null`、对 `Data:[]` 输出 `[]`、对 `Data:0` 输出 `0`，`--select` 对缺失路径会报错。混淆发生在 `--all-pages` 的 `locateRows()`。
- **已知的两种分页容器能够被当前代码识别，且 `--max-pages` 是真上限。** `Data` 裸数组和 `Data.Products` 都会定位到 rows，循环条件 `offset < maxPages` 不会多取一页。root array 也能聚合。`ProductRequest` 没有分页参数，故其单/多 ASIN 返回对象或数组不应支持 `--all-pages`，该混合形状不是分页 bug；阻断/重要项针对 null、猜数组和终止可靠性。
- **`config set` 本身不会接受凭据键，CLI 也没有 `--token` 参数。** `validateConfigValue()` 是正向 allowlist，除 domain/base-url/timeout/output 外一律拒绝；加载 config 时还拒绝 token/secret/password/account-sk 等形状。部署文档里的 `--token` 是死代码/文档残留，不代表当前命令行泄漏通道。
- **计费目录完整性和默认开放数量符合基线。** 52 个 registry 名均在 `ENDPOINT_BILLING` 中；默认结果为 41 open、11 blocked，未定价 `GetFavoriteKeyword` 按 unknown/Coin 处理。问题是 blocked 原因被错误当成互斥类别，而不是漏登记端点。
- **仓库扫描没有发现真实 Account-SK。** 仅命中源码里的字段名、文档示例和明确的 test sentinel；扫描没有打印候选值。不过不知道真实密钥的精确格式，不能把这一项当作完整秘密扫描证明。

## 覆盖声明

- 按任务给定顺序读完了 AGENTS、全部核心源码、Skill 与三份 reference、9 个测试文件、README 和两份 docs；另读了 types/errors/domains、Skill agent/evals 及 `.work/api-catalog.md`。没有审提交过程或 commit diff，因为任务要求结果审核且禁止 git。
- 没有调用任何 Sorftime endpoint，没有访问 `standardapi.sorftime.com`，因此没有独立复验计费数字、真实响应 shape、三条“实测必填”、ProductRequest CSV 结论、IP allowlist 或业务码语义；这些只按仓库中的实测声明、参考摘要和静态路径审核。
- 没有执行/读取真实 auth status、交互登录或 macOS Keychain，避免接触实际凭据；也未验证 Linux/Windows 权限语义、TTY 表格效果和真实网络下的 SIGINT 时序。
- `pnpm typecheck`、`pnpm lint` 和 Skill quick validator 通过。`pnpm test` 发现 90 项：87 项通过，3 项 localhost HTTP E2E 因当前沙箱禁止监听 `127.0.0.1`（`listen EPERM`）未执行完成；因此没有把这 3 项记作产品代码失败，也不能声明完整测试通过。
- 没有运行 `pnpm build`，因为它会覆盖现有 `dist/cli.js`/`dist/cli.d.ts`，与“禁止修改现有文件、只允许新建本报告”冲突；也未审生成 bundle 与 Docker 实际运行。没有使用 ssh、数据库或外网。
