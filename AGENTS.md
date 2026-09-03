# Codex project instructions

This file is the authoritative development guide for coding agents working in this repository. The root `README.md` is written for repository users; it is not a substitute for these instructions.

## Mission

Maintain a governed Sorftime data client with one deterministic API core and two surfaces:

- the CLI is the only execution path: endpoint routing, input validation, credentials, billing policy, pagination, output, and upstream error handling;
- the Sorftime Research Skill is the Host-side routing and interpretation protocol.

Probabilistic language understanding must end before endpoint selection and execution begin.

There is no MCP server. It was removed deliberately: its identity, rate-limit, and audit machinery served a multi-tenant server topology that this deployment does not have, and its policy layer exposed only free endpoints, which answered no business question.

## Start here

Read the smallest relevant set before changing code:

- CLI behavior: `src/cli.ts`, `src/runner.ts`, and `README.md`;
- endpoint contracts: `src/endpoints.ts`;
- exposure and billing policy: `src/policy.ts`;
- Skill behavior: `skills/sorftime-research/SKILL.md` and `docs/cli-skill-integration.md`;
- distribution, credentials, and rollout: `docs/deployment.md`.

## Compatibility baseline

- package version: `2.1.0`; billing policy: `1.0.0`;
- endpoint registry: 52 Sorftime endpoints, all reachable from the CLI;
- exposure policy: 41 of 52 endpoints open; 8 have Coin/current-or-recurring/unknown-cost consequences,
  9 are shared-state writes, 6 are in both sets, and the blocked union is 11;
- Skill: `sorftime-research`;
- runtime: Node.js 20+, TypeScript, no server dependencies.

## Non-negotiable invariants

1. Never commit or print a real Sorftime Account-SK, credential file, or `Authorization` header. `--verbose` must never reveal it.
2. `src/policy.ts` must classify all 52 endpoints for billing. Never derive cost from the human-readable `cost` string in `endpoints.ts`, which is advisory prose for `--help`.
3. Both blocks live in `assertEndpointAllowed()`, called from `runEndpoint()` before credential resolution and before any network call, so they also cover `sorftime-team api call`.
4. An endpoint absent from the billing catalog is treated as Coin-spending. Unpriced is not free.
5. `--allow-coin` and `--allow-write` are deliberate single-invocation overrides. Never make either a config default, an environment variable, or a Skill default. Everyone holds the same account-level credential, so a write changes what every colleague sees and `BestSellerListDelete` has no undo.
6. Retries stay at zero by default. A lost response must not duplicate paid work. Task-creating endpoints additionally require `--retry-unsafe`.
7. Preserve exact documented wire casing (`ASIN`, `Asin`, `Asins`, `Querystartdt`). Do not normalize payload keys at the client boundary.
8. Upstream unknown schemas remain JSON. Do not invent field meanings or present missing/unavailable values as zero.
9. Quota is account-global, never a per-person allowance. `500`, `501`, and `694` may be caused by another user; report and stop rather than retrying.
10. Credentials come from `sorftime-team auth login`, `SORFTIME_ACCOUNT_SK`, the OS keychain, or a mode-0600 file. `config set` must keep refusing credential-shaped keys.
11. The Skill must not request credentials, invent identifiers, silently substitute a different endpoint for a blocked one, or infer causality.
12. Do not reintroduce an MCP server, an HTTP transport, or a per-identity rate limiter without a topology that needs one.
13. Account-SK may be sent only to the canonical Sorftime origin, loopback, or an exact HTTPS origin
    set independently by deployment through `SORFTIME_TRUSTED_ORIGINS`. Reject URL userinfo and never
    turn remote-origin trust into an ordinary per-query flag.

## Module ownership

```text
src/cli.ts            Command tree, global flags, auth/config/utility commands
src/runner.ts         Execution orchestration, billing gate, pagination, guardrails
src/endpoints.ts      Complete endpoint/parameter registry (52 endpoints)
src/policy.ts         Billing/effect classification and the default exposure gate
src/service.ts        Deterministic API execution core
src/client.ts         HTTP, envelope, timeout, and response-size handling
src/config.ts         Credential resolution (keychain/file/env) and non-secret defaults
src/input.ts          Typed flag to wire-body construction
src/output.ts         Output formats, selection, atomic file writes
skills/sorftime-research/  Host routing and interpretation Skill
test/                 CLI, client, policy, endpoint, and Skill contract tests
```

## Change workflow

1. Inspect the worktree and preserve unrelated user changes.
2. Identify which boundary changes: endpoint registry, billing policy, CLI surface, or Skill.
3. Implement the smallest coherent change.
4. Update tests at the same boundary:
   - endpoint/core: `client`, `input`, `endpoints`, and `cli.e2e` tests;
   - policy: `policy` tests, including the blocked-set assertions;
   - Skill: `skill-contract` tests and evals.
5. Update README for user behavior, and AGENTS/Skill references for invariant changes.
6. Run `pnpm check` and the Skill validator.
7. Live checks must respect the billing policy: no Coin calls, and confirm the request cost first.

## CLI and Skill lockstep

When a command name, flag, billing classification, error code, or interpretation rule changes:

- update the runtime code;
- update `skills/sorftime-research/SKILL.md` or its selected reference;
- update Skill evals and `test/skill-contract.test.ts`;
- update `docs/cli-skill-integration.md` and README if user behavior changes.

The Skill must discover uncertain capability through `sorftime-team endpoints` and `--help`. It must not become a second endpoint registry.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check
```

Skill validation:

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py skills/sorftime-research
pnpm exec vitest run test/skill-contract.test.ts
```

## Review checklist

- Do the billing and effect catalogs still classify every registered endpoint?
- Can a Coin-spending or state-changing call reach the network without its explicit override?
- Could a secret enter output, logs, fixtures, docs, or git?
- Are empty, unavailable, blocked, and zero kept distinct?
- Do CLI help, Skill, README, and billing classification agree?
- Does cancellation reach the upstream fetch?
- Does the registry still cover all 52 endpoints, with exactly 11 blocked?

## Git and release

- Keep commits scoped and descriptive.
- Never commit `.env`, credential files, `dist`, coverage, or raw API output.
- Before pushing, run `git diff --check`, `pnpm check`, Skill validation, and a token-value scan against the source note without printing the token.
- A passing local build does not prove the team rollout is ready. Credential distribution, rotation, offboarding, quota headroom, and the upstream IP allowlist question remain rollout responsibilities; see `docs/deployment.md`.
