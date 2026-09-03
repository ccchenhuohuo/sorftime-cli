import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

interface RunResult { stdout: string; stderr: string; code: number | null }

function runCli(arguments_: string[], env: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...arguments_], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

describe("CLI contract", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("prints version and help without treating them as errors", async () => {
    const version = await runCli(["--version"], {});
    expect(version).toEqual({ stdout: `${VERSION}\n`, stderr: "", code: 0 });
    const help = await runCli(["product", "--help"], {});
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Commands:");

    const keywordHelp = await runCli(["keyword", "list", "--help"], {});
    expect(keywordHelp.code).toBe(0);
    expect(keywordHelp.stdout).toMatch(/--pattern[\s\S]*required[\s\S]*runtime-verified\s+requirement/u);
    const agentHelp = await runCli(["agent", "status", "--help"], {});
    expect(agentHelp.stdout).toMatch(/--query-start[\s\S]*required[\s\S]*runtime-verified\s+requirement/u);
    expect(agentHelp.stdout).toMatch(/--query-end[\s\S]*required[\s\S]*runtime-verified\s+requirement/u);

    const discovery = await runCli(["endpoints", "--json"], {});
    const endpoints = JSON.parse(discovery.stdout) as Array<{ name: string; blocked: string[] }>;
    expect(endpoints.find((item) => item.name === "KeywordBatchSubscription")?.blocked).toEqual(["coin", "write"]);
    expect(endpoints.find((item) => item.name === "CoinQuery")?.blocked).toEqual([]);
  });

  it("sends identical ProductRequest wire bodies through all five input paths", async () => {
    const observed: Array<{ url: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed.push({
          url: request.url,
          auth: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Code: 0, Data: [{ ASIN: "B000TEST" }] }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const env = {
      SORFTIME_ACCOUNT_SK: "e2e-sentinel-secret",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    };
    const rawBody = '{"ASIN":["B000TEST01","B000TEST02"],"Trend":2}';
    const directory = await mkdtemp(join(tmpdir(), "sorftime-e2e-body-"));
    const path = join(directory, "body.json");
    await writeFile(path, rawBody);

    const result = await runCli([
      "--domain", "jp", "--data-only", "--output", "json", "product", "get",
      "--asin", "B000TEST01", "B000TEST02", "--trend", "2",
    ], env);
    const remaining = await Promise.all([
      runCli(["--domain", "jp", "--output", "json", "product", "get", "--data", rawBody], env),
      runCli(["--domain", "jp", "--output", "json", "product", "get", "--data-file", path], env),
      runCli(["--domain", "jp", "--output", "json", "product", "get", "--stdin"], env, rawBody),
      runCli(["--domain", "jp", "--output", "json", "api", "call", "ProductRequest", "--data", rawBody], env),
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([{ ASIN: "B000TEST" }]);
    expect(remaining.map((item) => item.code)).toEqual([0, 0, 0, 0]);
    expect(observed).toHaveLength(5);
    for (const request of observed) {
      expect(request).toEqual({
        url: "/api/ProductRequest?domain=7",
        auth: "BasicAuth e2e-sentinel-secret",
        body: { ASIN: "B000TEST01,B000TEST02", Trend: 2 },
      });
    }
    expect([result, ...remaining].flatMap((item) => [item.stdout, item.stderr]).join(""))
      .not.toContain("e2e-sentinel-secret");
  }, 15_000);

  it("continues after a short page and stops only on an empty terminal page", async () => {
    const observedPages: number[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { PageIndex: number };
        observedPages.push(body.PageIndex);
        const rows = body.PageIndex === 1
          ? Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }))
          : body.PageIndex === 2 ? [{ id: 21 }] : [];
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Code: 0, Data: rows }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const result = await runCli([
      "--all-pages", "--output", "json", "keyword", "list",
      "--pattern", '{"RankCondition":[1,1000]}', "--page-size", "20",
    ], {
      SORFTIME_ACCOUNT_SK: "pagination-sentinel",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(observedPages).toEqual([1, 2, 3]);
    const output = JSON.parse(result.stdout) as { Data: unknown[]; _pagination: { pagesFetched: number } };
    expect(output.Data).toHaveLength(21);
    expect(output._pagination.pagesFetched).toBe(3);
  }, 15_000);

  it("rejects empty ProductRequest arrays and unknown api-call endpoints locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sorftime-e2e-config-"));
    const env = { SORFTIME_CONFIG_DIR: directory, SORFTIME_ACCOUNT_SK: "validation-sentinel" };
    const emptyBody = '{"ASIN":[]}';
    const path = join(directory, "empty-body.json");
    await writeFile(path, emptyBody);
    for (const [arguments_, input] of [
      [["product", "get", "--data", emptyBody], undefined],
      [["product", "get", "--data-file", path], undefined],
      [["product", "get", "--stdin"], emptyBody],
      [["api", "call", "ProductRequest", "--data", emptyBody], undefined],
    ] as const) {
      const result = await runCli([...arguments_], env, input);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Missing required option --asin");
    }
    const unknown = await runCli(["api", "call", "FutureEndpoint", "--data", "{}"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("sorftime-team endpoints");
    expect(unknown.stdout + unknown.stderr).not.toContain("validation-sentinel");
  });

  it("keeps dual-axis policy ahead of raw, api-call, and pagination paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sorftime-e2e-policy-"));
    const env = { SORFTIME_CONFIG_DIR: directory, SORFTIME_ACCOUNT_SK: "policy-order-sentinel" };
    const invocations = [
      ["--allow-coin", "monitor", "keyword-create", "--data", '{}'],
      ["--allow-coin", "api", "call", "KeywordBatchSubscription", "--data", '{}'],
      ["--allow-coin", "--all-pages", "api", "call", "KeywordBatchSubscription", "--data", '{}'],
    ];
    for (const arguments_ of invocations) {
      const result = await runCli(arguments_, env);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--allow-write");
      expect(result.stdout + result.stderr).not.toContain("policy-order-sentinel");
    }
  });

  it("blocks retries for mutating endpoints unless explicitly acknowledged", async () => {
    const result = await runCli([
      "--retries", "1", "product", "realtime-start", "--asin", "B000TEST",
    ], { SORFTIME_ACCOUNT_SK: "unsafe-retry-sentinel" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Retry is disabled unless --retry-unsafe");
    expect(result.stdout + result.stderr).not.toContain("unsafe-retry-sentinel");
  });

  it("preserves raw bytes and exit code 130 when SIGINT cancels the next request", async () => {
    const exact = ` { "Code": 0, "Data": [] }\n`;
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount > 1) return;
      response.setHeader("content-type", "application/json");
      response.end(exact);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const result = await runCli(["--output", "raw", "account", "coins"], {
      SORFTIME_ACCOUNT_SK: "raw-sentinel",
      SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
    });
    expect(result).toEqual({ stdout: exact, stderr: "", code: 0 });

    const interrupted = await new Promise<RunResult>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--output", "json", "account", "coins"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SORFTIME_ACCOUNT_SK: "sigint-sentinel",
          SORFTIME_BASE_URL: `http://127.0.0.1:${address.port}/api/`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      server.once("request", () => child.kill("SIGINT"));
      child.once("close", (code) => resolve({ stdout, stderr, code }));
    });
    expect(interrupted.code).toBe(130);
    expect(interrupted.stdout + interrupted.stderr).not.toContain("sigint-sentinel");
  }, 15_000);
});
