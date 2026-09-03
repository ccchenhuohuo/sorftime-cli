# CLI × Skill 联动

## 分工

| 层 | 承载 | 不承载 |
|---|---|---|
| `sorftime` CLI | 参数校验、端点路由、凭据、计费闸、分页、输出、上游错误 | 意图理解、口径解释 |
| Sorftime Research Skill | 意图路由、缺参澄清、花钱前确认、证据与口径纪律 | 执行、凭据、端点清单 |

一条原则：**能在 CLI 里硬做的就硬做，做不成硬约束的才写进 Skill。** 提示词是建议性的，Host 可以不采纳；`runner.ts` 里的 `assertEndpointAllowed()` 不可绕过。Coin 与写操作的拦截因此放在 CLI，不放在 Skill。

## Skill 不复制端点注册表

Skill 里**没有**52 个端点的清单，只有一张覆盖常见意图的路由表和一句"不确定就问 CLI"：

```bash
sorftime endpoints --group keyword
sorftime category best-sellers --help
```

理由：注册表会漂移，Skill 里的副本会过期，而过期的副本比没有更危险。`sorftime endpoints --json` 输出里带 `billing` 和 `blocked` 字段，Skill 据此判断可用性，而不是靠记忆。

## 需要同步改动的边界

改动以下任一项时，四处必须一起改：

| 改了什么 | 要同步的 |
|---|---|
| 端点增删、命令名、参数名 | `src/endpoints.ts` → `test/endpoints.test.ts` → Skill 路由表 → README 命令表 |
| 计费分类、Coin/写操作闸 | `src/policy.ts` → `test/policy.test.ts` → SKILL.md 被拦表 → README 开放策略表 |
| 全局 flag | `src/cli.ts` / `src/types.ts` → `references/cli-contract.md` |
| 口径纪律 | `references/interpretation-boundaries.md` → `evals/evals.json` |

`test/skill-contract.test.ts` 是这条纪律的门禁：它从 `src/policy.ts` 反查所有被拦端点，逐个断言 Skill 文本里提到了对应的 CLI 命令。新增一个被拦端点而不更新 Skill，测试会红。它同时断言 Skill 文本里不出现 `MCP` 字样，防止旧形态回流。

## 花钱前的确认

CLI 不做交互式确认（它要能在脚本里跑），所以"确认成本"这一步落在 Skill：

1. 报出端点、站点、预估 requests；
2. 历史区间要把块数算出来，不能只说"要查一个月"；
3. `--all-pages` 必须先取第 1 页看形状，再定 `--max-pages`；
4. `--allow-coin`、`--allow-write` 和 `--force` 永远由用户拍板，Skill 不自作主张。

## 已知的不对称

- CLI 注册了全部 52 个端点，但默认只放行 41 个；另外 11 个要显式 `--allow-coin` / `--allow-write`。Skill 只路由常用意图。
- CLI 不知道"这次分析要花多少"，只知道单条命令的文档成本；总预算控制目前只有人在管。
- 每台机器的 CLI 各自独立，没有跨机器的用量视图。`sorftime account request-stream` 看到的是账号总量。
