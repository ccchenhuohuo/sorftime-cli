import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { USER_AGENT, VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is the only thing the user agent embeds", () => {
    expect(USER_AGENT).toBe(`sorftime-cli/${VERSION}`);
  });
});
