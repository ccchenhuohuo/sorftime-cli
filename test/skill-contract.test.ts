import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { blockedReason } from "../src/policy.js";
import { ENDPOINTS } from "../src/endpoints.js";

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
    for (const command of ["sorftime auth status", "sorftime endpoints", "sorftime account request-stream"]) {
      expect(sources).toContain(command);
    }
    expect(sources).not.toMatch(/\bMCP\b/u);
    expect(sources).not.toMatch(/sorftime_(capabilities|check_quota|list_monitors|get_monitoring_results)/u);
  });

  it("names every blocked endpoint so the Skill cannot offer one", async () => {
    const sources = await allText();
    // The Skill speaks in CLI commands, so assert the group/command pair is mentioned.
    const blocked = ENDPOINTS.filter((endpoint) => blockedReason(endpoint.name) !== undefined);
    expect(blocked).toHaveLength(11);
    for (const endpoint of blocked) {
      const command = `${endpoint.group} ${endpoint.command}`;
      expect(sources, `Skill never mentions blocked command '${command}' (${endpoint.name})`).toContain(command);
    }
  });

  it("keeps the cost, credential, and interpretation guardrails", async () => {
    const sources = await allText();
    expect(sources).toContain("--allow-coin");
    expect(sources).toContain("--allow-write");
    expect(sources).toContain("account-global");
    expect(sources).toMatch(/never pass (it|either) on your own initiative/iu);
    expect(sources).toMatch(/truncated set/iu);
    expect(sources).toMatch(/infer causality/iu);
    expect(sources).toMatch(/smallest currency unit/iu);
    expect(sources).toMatch(/never ask the user for the Account-SK|never accept one pasted/iu);
  });

  it("contains a lean portable reference and eval set", async () => {
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
    expect([await allText(), JSON.stringify(evals)].join("\n")).not.toMatch(/\/Users\//u);
  });
});
