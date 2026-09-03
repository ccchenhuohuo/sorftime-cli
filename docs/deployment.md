# 分发与团队上线清单

本项目没有服务端。分发的是一个本地 CLI 加一份 Skill，每台机器各自直连 Sorftime API。

```text
每位使用者的机器
  Codex / Claude Code
    └─ Sorftime Research Skill
         └─ sorftime CLI ── Account-SK（本机钥匙串或 0600 文件）
              └─ https://standardapi.sorftime.com/api/
```

## 分发前必须知道的三件事

**1. Sorftime 没有按人分发的令牌。** 鉴权只有一个账号级 Account-SK。"给每人一个访问令牌"在这个 API 上不成立——实际发生的是同一把账号凭据被复制 N 份。后果：泄漏源无法从上游区分；轮换必须全员同时进行；离职回收依赖每台机器执行 `sorftime auth logout`，没有服务端可以吊销。

**2. 配额与限流是账号全局的。** 一个人的误操作会占用所有人的额度。上线前确认月度额度，并把下面这条讲清楚：`500`（月度上限）、`501`（每分钟上限）、`694`（次数不足）都可能由同事触发，遇到就停，不要重试。多人并发跑批时 `501` 会互相踩踏，用 `--page-delay` 缓解。

**3. 上游可能有 IP 白名单。** 错误码 `400` 的含义是「未认证的 IP」。笔记本的出口 IP 会随网络变化，居家办公、换 WiFi、连 VPN 都会变。分发前先用一台机器验证：换一个网络环境后 `sorftime account request-stream` 是否仍然返回 `0`。如果确实存在白名单，人手一份的模式需要先解决出口 IP 收敛（例如统一走公司出口或跳板机）。

## 安装

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install -g .
sorftime --version
```

## 凭据

```bash
sorftime auth login              # 交互式，输入不回显
sorftime auth login --token-stdin # 脚本/自动化
sorftime auth status             # 只报告有无，不打印值
sorftime auth logout             # 离职或换机时执行
```

`auth login` **总是**把凭据原子写入 `credentials.json`（权限 `0600`，目录 `0700`），不写钥匙串——这样凭据不会出现在进程参数里。读取优先级是：`SORFTIME_ACCOUNT_SK` 环境变量 > 旧版本遗留的 macOS 钥匙串项 > 0600 凭据文件；CLI 不提供 `--token`。钥匙串只在读取路径上做旧版本兼容，`auth logout` 会一并清掉；设 `SORFTIME_CREDENTIAL_STORE=file` 可跳过钥匙串查找。

凭据文件不是只在创建时 chmod：每次读取都要求它是当前用户拥有的普通文件、不是符号链接，
且 POSIX group/other 权限为零；`0644` 等文件会被拒绝并提示 `chmod 600`。

## 自定义 API origin

canonical `https://standardapi.sorftime.com` 与 loopback 测试 origin 默认可信。远程代理不能只靠
普通查询可携带的 `--base-url`、`SORFTIME_BASE_URL` 或 config 开启；部署管理员还必须设置独立的
精确 origin 白名单，例如：

```bash
export SORFTIME_TRUSTED_ORIGINS='https://sorftime-proxy.example.com,https://backup-proxy.example.com:8443'
```

只接受逗号分隔的 HTTPS origin，不接受 path、query、fragment 或 userinfo，端口也必须精确匹配。
URL 自带 `user:password@` 一律拒绝。未授权 remote origin 会在读取 Account-SK 和发请求之前失败。

不要把真实值放进：命令行参数、提交的 `.env`、CI 日志、截图、工单、Skill 文件、容器镜像层。

## 容器

`Dockerfile` 产出一个运维用的 CLI 镜像，凭据在运行时注入，不进镜像层：

```bash
docker run --rm -e SORFTIME_ACCOUNT_SK=... sorftime-cli account request-stream
```

## 上线检查

- [ ] 月度 request 额度已确认，并按预计用量估算过够不够
- [ ] 已在第二个网络环境验证过没有 IP 白名单问题（错误码 `400`）
- [ ] 每位使用者都知道配额是共享的，以及遇到 `500`/`501`/`694` 要停不要重试
- [ ] `sorftime endpoints` 的 `STATUS` 列已向使用者说明，且大家知道 `COIN+WRITE` 必须两个单次 flag 都明确批准
- [ ] 凭据轮换流程写下来了（谁通知、多久、怎么确认全员完成）
- [ ] 离职/换机的 `sorftime auth logout` 纳入了 offboarding 清单
- [ ] Skill 已装到各自的 Host（`$CODEX_HOME/skills/` 或 `.claude/skills/`）

## 这个形态换不来的东西

分发 CLI 意味着放弃以下能力，接受它们之前先确认没有人在依赖：

- **分人用量**：查不到谁花了多少配额，只有账号总量。
- **服务端限流**：拦不住任何单机的批量误操作，只有 CLI 自己的 `--max-pages` 这类本机护栏。
- **集中审计**：没有统一日志，出问题只能逐台机器查。
- **凭据不落地**：凭据必然出现在每台机器上。
- **结果可复现**：每次调用拿到的都是当时的实时值，不落库就无法回放，也无法核对上周的结论是基于什么数据得出的。
