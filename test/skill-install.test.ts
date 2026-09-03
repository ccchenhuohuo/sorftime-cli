import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { bundledSkillDirectory, hostSkillDirectory, installSkill } from "../src/skill.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("skill install", () => {
  it("resolves the bundled Skill from both the dist and source layouts", () => {
    expect(bundledSkillDirectory("file:///pkg/dist/cli.js")).toBe("/pkg/skills/sorftime-research");
    expect(bundledSkillDirectory("file:///repo/src/cli.ts")).toBe("/repo/skills/sorftime-research");
  });

  it("targets the documented host directories", () => {
    expect(hostSkillDirectory("claude", {})).toMatch(/\.claude\/skills\/sorftime-research$/u);
    expect(hostSkillDirectory("codex", { CODEX_HOME: "/custom" })).toBe("/custom/skills/sorftime-research");
  });

  it("copies the real Skill and lands a usable SKILL.md", async () => {
    const target = await mkdtemp(join(tmpdir(), "skill-install-"));
    created.push(target);
    const result = await installSkill(new URL("../src/cli.ts", import.meta.url).href, "claude", target);
    expect(result.to).toBe(join(target, "sorftime-research"));
    expect((await readdir(result.to)).sort()).toEqual(["SKILL.md", "agents", "evals", "references"]);
    expect(await readFile(join(result.to, "SKILL.md"), "utf8")).toContain("name: sorftime-research");
  });

  it("fails with a clear message when no Skill is bundled", async () => {
    await expect(installSkill("file:///nowhere/dist/cli.js", "claude"))
      .rejects.toThrow(ValidationError);
  });
});
