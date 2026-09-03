# CLI × Skill 联动

## 分工

| 层 | 承载 | 不承载 |
|---|---|---|
| `sorftime-team` CLI | 参数校验、端点路由、凭据、计费闸、分页、输出、上游错误 | 意图理解、口径解释 |
| Sorftime Research Skill | 意图路由、缺参澄清、花钱前确认、证据与口径纪律 | 执行、凭据、端点清单 |

一条原则：**能在 CLI 里硬做的就硬做，做不成硬约束的才写进 Skill。** 提示词是建议性的，Host 可以不采纳；`runner.ts` 里的 `assertEndpointAllowed()` 不可绕过。Coin 与写操作的拦截因此放在 CLI，不放在 Skill。

## Skill 不复制端点注册表

Skill 里**没有**52 个端点的清单，只有一张覆盖常见意图的路由表和一句"不确定就问 CLI"：

```bash
sorftime-team endpoints --group keyword
sorftime-team category best-sellers --help
```

理由：注册表会漂移，Skill 里的副本会过期，而过期的副本比没有更危险。`sorftime-team endpoints --json` 输出里带 `billing`、`effect` 和 `blocked` 数组，Skill 据此识别独立策略轴，而不是靠记忆。

## 需要同步改动的边界

改动以下任一项时，四处必须一起改：

| 改了什么 | 要同步的 |
|---|---|
| 端点增删、命令名、参数名 | `src/endpoints.ts` → `test/endpoints.test.ts` → Skill 路由表 → README 命令表 |
| 计费分类、Coin/写操作闸 | `src/policy.ts` → `test/policy.test.ts` → SKILL.md 被拦表 → README 开放策略表 |
| 全局 flag | `src/cli.ts` / `src/types.ts` → `references/cli-contract.md` |
| 口径纪律 | `references/interpretation-boundaries.md` → `evals/evals.json` |

`test/skill-contract.test.ts` 是这条纪律的语义门禁：它解析 Skill 的路由表和策略表，逐行把
endpoint、CLI 命令、必填 flag、成本文本、blocked 轴与所需 override 对回
`createProgram()`、registry 和 policy；双属性端点必须同时列出两个 flag，任何可执行示例都不得
主动携带 override。eval 的 `expected_output` 也逐条检查站点澄清、成本确认、分页不得推断、
限流停止和凭据边界等语义，而不再只统计条目数量。测试仍禁止旧 MCP 形态回流。

## 花钱前的确认

CLI 不做交互式确认（它要能在脚本里跑），所以"确认成本"这一步落在 Skill：

1. 先从 CLI discovery 核对 billing；free 明示为 0，任何非 free 调用都报出端点、站点、预估成本并取得同意；
2. 历史区间要把块数算出来，不能只说"要查一个月"；
3. `--all-pages` 必须先取第 1 页看形状，再定 `--max-pages`；
4. `--allow-coin`、`--allow-write` 和 `--force` 永远由用户拍板，Skill 不自作主张；双属性端点只批准一个轴时仍不得执行。

## 已知的不对称

- CLI 注册了全部 52 个端点，但默认只放行 41 个；另外 11 个要显式 `--allow-coin` / `--allow-write`。Skill 只路由常用意图。
- CLI 不知道"这次分析要花多少"，只知道单条命令的文档成本；总预算控制目前只有人在管。
- 每台机器的 CLI 各自独立，没有跨机器的用量视图。`sorftime-team account request-stream` 看到的是账号总量。
