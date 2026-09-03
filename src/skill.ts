import { cp, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./errors.js";

const SKILL_NAME = "sorftime-research";

export type SkillHost = "claude" | "codex";

/**
 * The bundled Skill sits next to the entrypoint's parent in both layouts:
 * `<pkg>/dist/cli.js` and `<repo>/src/cli.ts` both resolve to `<root>/skills`.
 */
export function bundledSkillDirectory(entryUrl: string): string {
  return resolve(dirname(fileURLToPath(entryUrl)), "..", "skills", SKILL_NAME);
}

export function hostSkillDirectory(host: SkillHost, env: NodeJS.ProcessEnv = process.env): string {
  if (host === "codex") {
    return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", SKILL_NAME);
  }
  return join(homedir(), ".claude", "skills", SKILL_NAME);
}

export async function installSkill(
  entryUrl: string,
  host: SkillHost,
  explicitDirectory?: string,
): Promise<{ from: string; to: string }> {
  const from = bundledSkillDirectory(entryUrl);
  try {
    const metadata = await stat(from);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ValidationError(
      `Bundled Skill not found at ${from}. Install the CLI from a release tarball rather than a bare checkout.`,
    );
  }
  const to = explicitDirectory ? resolve(explicitDirectory, SKILL_NAME) : hostSkillDirectory(host);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
  return { from, to };
}
