# Claude Code project instructions

Read [AGENTS.md](AGENTS.md) first. It is the shared, authoritative development guide; the user-facing `README.md` is not an AI coding instruction file.

## Claude-specific routing

- Follow the module and safety boundaries in `AGENTS.md` for implementation work.
- For Sorftime end-user data questions, read `skills/sorftime-research/SKILL.md` and only the references it selects.
- If installed under `.claude/skills/sorftime-research`, invoke `/sorftime-research`.
- The CLI performs execution and policy enforcement; the Skill performs routing, cost confirmation, and interpretation; this file only adapts repository instructions to Claude Code.

## Hard stops

- Do not expose or request credentials.
- Do not spend Coin and do not change shared account state. Eleven endpoints are blocked in `src/policy.ts`; never pass `--allow-coin` or `--allow-write` without the user saying so.
- Do not spend request quota without telling the user the cost first. The quota is account-global and shared.
- Do not reintroduce an MCP server, HTTP transport, or per-identity rate limiter.
- Do not treat missing, unavailable, or blocked data as zero, and do not infer causality from rank or list changes.
- Do not change the CLI surface without updating the Skill, tests, and user documentation together.

Run `pnpm check` and Skill validation before handing off changes.
