import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createProgram } from "../src/cli.js";
import { ENDPOINTS } from "../src/endpoints.js";
import { optionName } from "../src/input.js";
import { blockedReasons } from "../src/policy.js";

const root = resolve(process.cwd(), "skills/sorftime-research");
const text = (path: string): Promise<string> => readFile(join(root, path), "utf8");

const allText = async (): Promise<string> => {
  const references = await readdir(join(root, "references"));
  return [
    await text("SKILL.md"),
    await text("agents/openai.yaml"),
    ...(await Promise.all(references.map((file) => text(`references/${file}`)))),
  ].join("\n");
};

interface BlockedSkillRow {
  command: string;
  endpoint: string;
  flags: string[];
  consequence: string;
}

function blockedTableRows(skill: string): BlockedSkillRow[] {
  return skill.split("\n").flatMap((line) => {
    const match = /^\| `([^`]+)` \| `([^`]+)` \| (.+?) \| (.+) \|$/u.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]
      || !ENDPOINTS.some((endpoint) => endpoint.name === match[2])) return [];
    return [{
      command: match[1],
      endpoint: match[2],
      flags: [...match[3].matchAll(/`(--allow-(?:coin|write))`/gu)].map((item) => item[1] as string),
      consequence: match[4],
    }];
  });
}

interface RouteRow {
  endpoint: string;
  command: string;
  cost: string;
}

// Derive the binary name from package.json so renaming the bin cannot silently
// break this guard the way a hardcoded literal did.
const BIN_NAME = Object.keys(
  (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { bin: Record<string, string> }).bin,
)[0]!;

function routeTableRows(skill: string): RouteRow[] {
  // Assembled from a plain string rather than String.raw: an escaped backtick is
  // an invalid identity escape under the u flag and throws at construction time.
  const tick = "`";
  const cell = `${tick}([^${tick}]+)${tick}`;
  const commandCell = `${tick}(${BIN_NAME} [^${tick}]+)${tick}`;
  const rowPattern = new RegExp(`^\\| [^|]+ \\| ${cell} \\| ${commandCell} \\| ${cell} \\|$`, "u");
  return skill.split("\n").flatMap((line) => {
    const match = rowPattern.exec(line);
    return match?.[1] && match[2] && match[3]
      ? [{ endpoint: match[1], command: match[2], cost: match[3] }]
      : [];
  });
}

describe("sorftime-research Skill contract", () => {
  it("uses minimal portable metadata and an implicit invocation policy", async () => {
    const skill = await text("SKILL.md");
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(skill);
    expect(match).not.toBeNull();
    const metadata = parseYaml(match![1]!) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["description", "name"]);
    expect(metadata.name).toBe("sorftime-research");
    expect(String(metadata.description)).toContain("Sorftime CLI");
    expect(skill).not.toContain("TODO");

    const agent = parseYaml(await text("agents/openai.yaml")) as {
      interface?: { default_prompt?: string };
      policy?: { allow_implicit_invocation?: boolean };
    };
    expect(agent.interface?.default_prompt).toContain("$sorftime-research");
    expect(agent.policy?.allow_implicit_invocation).toBe(true);
  });

  it("routes through the CLI and carries no MCP surface", async () => {
    const sources = await allText();
    for (const command of ["sorftime-team auth status", "sorftime-team endpoints", "sorftime-team account request-stream"]) {
      expect(sources).toContain(command);
    }
    expect(sources).not.toMatch(/\bMCP\b/u);
    expect(sources).not.toMatch(/sorftime_(capabilities|check_quota|list_monitors|get_monitoring_results)/u);
  });

  it("maps every blocked endpoint to its exact axes and never embeds an override in a command", async () => {
    const skill = await text("SKILL.md");
    const rows = blockedTableRows(skill);
    const blocked = ENDPOINTS.filter((endpoint) => blockedReasons(endpoint.name).length > 0);
    expect(blocked).toHaveLength(11);
    expect(rows).toHaveLength(blocked.length);
    expect(new Set(rows.map((row) => row.endpoint)).size).toBe(rows.length);

    for (const endpoint of blocked) {
      const row = rows.find((item) => item.endpoint === endpoint.name);
      expect(row, `missing semantic policy row for ${endpoint.name}`).toBeDefined();
      expect(row?.command).toBe(`${endpoint.group} ${endpoint.command}`);
      const expectedFlags = blockedReasons(endpoint.name).map((reason) => `--allow-${reason.kind}`).sort();
      expect(row?.flags.sort()).toEqual(expectedFlags);
      for (const reason of blockedReasons(endpoint.name)) {
        expect(row?.consequence.toLowerCase()).toContain(reason.kind === "coin" ? "coin" : "shared");
      }
    }

    const executableLines = skill.split("\n").filter((line) => /sorftime\s/u.test(line));
    expect(executableLines.join("\n")).not.toMatch(/sorftime[^\n]*--allow-(coin|write)/u);
    expect(skill).toMatch(/never pass either on your own initiative/iu);
  });

  it("keeps curated route commands, required flags, and cost prose aligned with the CLI registry", async () => {
    const skill = await text("SKILL.md");
    const rows = routeTableRows(skill);
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const program = createProgram();

    for (const row of rows) {
      const endpoint = ENDPOINTS.find((item) => item.name === row.endpoint);
      expect(endpoint, `unknown route endpoint ${row.endpoint}`).toBeDefined();
      if (!endpoint) continue;
      expect(row.cost).toBe(endpoint.cost);
      expect(row.command).toContain(` ${endpoint.group} ${endpoint.command}`);

      const group = program.commands.find((command) => command.name() === endpoint.group);
      const command = group?.commands.find((candidate) => candidate.name() === endpoint.command);
      expect(command, `missing CLI command ${endpoint.group} ${endpoint.command}`).toBeDefined();
      const availableFlags = new Set([
        ...program.options.map((option) => option.long),
        ...(command?.options.map((option) => option.long) ?? []),
      ]);
      for (const flag of row.command.match(/--[a-z][a-z0-9-]*/gu) ?? []) expect(availableFlags.has(flag)).toBe(true);
      for (const parameter of endpoint.parameters.filter((item) => item.required)) {
        expect(row.command, `${endpoint.name} route omits required ${parameter.key}`)
          .toContain(`--${optionName(parameter.key)}`);
      }
    }
  });

  it("states one unambiguous cost and credential policy", async () => {
    const sources = await allText();
    expect(sources).toMatch(/`free` means zero request-quota and zero Coin cost/iu);
    expect(sources).toMatch(/any `request`, `coin`,\s*`recurring_coin`, or `unknown` call requires/iu);
    expect(sources).toMatch(/no\s+"small enough to skip confirmation" exception/iu);
    expect(sources).not.toMatch(/every data call spends/iu);
    expect(sources).toContain("account-global");
    expect(sources).toMatch(/truncated set/iu);
    expect(sources).toMatch(/infer causality/iu);
    expect(sources).toMatch(/smallest currency unit/iu);
    expect(sources).toMatch(/never ask the user for the Account-SK|never accept one pasted/iu);
  });

  it("semantically lints every eval's expected behavior", async () => {
    expect((await readdir(join(root, "references"))).sort()).toEqual([
      "cli-contract.md",
      "interpretation-boundaries.md",
      "workflows.md",
    ]);
    const evals = JSON.parse(await text("evals/evals.json")) as {
      skill_name: string;
      evals: Array<{ id: number; prompt: string; expected_output: string }>;
    };
    expect(evals.skill_name).toBe("sorftime-research");
    expect(evals.evals).toHaveLength(12);
    expect(new Set(evals.evals.map((item) => item.id)).size).toBe(12);
    expect(new Set(evals.evals.map((item) => item.prompt)).size).toBe(12);

    const requirements: Record<number, RegExp[]> = {
      1: [/request-stream/u, /account-global/u],
      2: [/NodeId/u, /instead of guessing/u, /wait for agreement/u],
      3: [/100 requests/u, /confirm/u],
      4: [/Ask which marketplace/u, /wait for agreement/u],
      5: [/blocked/u, /--allow-coin/u, /already-collected/u],
      6: [/both independent axes/u, /--allow-coin/u, /--allow-write/u],
      7: [/truncated set/u, /Refuse/u],
      8: [/without asserting a cause/u, /decline to attribute/u],
      9: [/Decline to sum/u, /no exchange rate/u],
      10: [/Do not infer/u, /--max-pages/u, /wait for agreement/u],
      11: [/account-global/u, /stop instead of retrying/u],
      12: [/Refuse to accept or store/u, /auth login --token-stdin/u],
    };
    for (const evaluation of evals.evals) {
      for (const requirement of requirements[evaluation.id] ?? []) {
        expect(evaluation.expected_output, `eval ${evaluation.id} misses ${requirement}`).toMatch(requirement);
      }
    }
    expect([await allText(), JSON.stringify(evals)].join("\n")).not.toMatch(/\/Users\//u);
  });
});
