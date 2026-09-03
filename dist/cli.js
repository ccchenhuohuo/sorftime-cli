#!/usr/bin/env node

// src/cli.ts
import { password } from "@inquirer/prompts";
import { Command, CommanderError, Option } from "commander";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

// src/errors.ts
var CliError = class extends Error {
  constructor(message, exitCode = 1, details) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
    this.name = new.target.name;
  }
  exitCode;
  details;
};
var ValidationError = class extends CliError {
  constructor(message, details) {
    super(message, 2, details);
  }
};
var AuthenticationError = class extends CliError {
  constructor(message) {
    super(message, 3);
  }
};
var NetworkError = class extends CliError {
  constructor(message, details) {
    super(message, 4, details);
  }
};
var ApiError = class extends CliError {
  constructor(message, apiCode, details) {
    super(message, 5, details);
    this.apiCode = apiCode;
  }
  apiCode;
};

// src/client.ts
var DEFAULT_BASE_URL = "https://standardapi.sorftime.com/api/";
var DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
var TRUSTED_ORIGINS_ENV = "SORFTIME_TRUSTED_ORIGINS";
var CANONICAL_ORIGIN = new URL(DEFAULT_BASE_URL).origin;
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
var API_MESSAGES = {
  4: "Insufficient coin balance",
  9: "Resource access is restricted",
  10: "Invalid request parameters",
  400: "Request originated from an unauthorized IP address",
  401: "This API endpoint is not enabled for the account",
  402: "The account is not authorized to view this data",
  500: "Monthly request quota has been exhausted",
  501: "Per-minute request quota has been reached",
  694: "Insufficient request balance"
};
function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(input.endsWith("/") ? input : `${input}/`);
  } catch {
    throw new ValidationError("Invalid base URL.");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new ValidationError("Base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ValidationError("Base URL userinfo is forbidden; credentials must not appear in a URL.");
  }
  if (url.search || url.hash) throw new ValidationError("Base URL must not contain a query or fragment.");
  return url;
}
function deploymentTrustedOrigins(raw) {
  const origins = /* @__PURE__ */ new Set();
  for (const entry of raw?.split(",") ?? []) {
    const value = entry.trim();
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError(`${TRUSTED_ORIGINS_ENV} must be a comma-separated list of HTTPS origins.`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new ValidationError(`${TRUSTED_ORIGINS_ENV} must contain HTTPS origins only (no path, query, fragment, or userinfo).`);
    }
    origins.add(url.origin);
  }
  return origins;
}
function validateCredentialDestination(input, trustedOrigins = process.env[TRUSTED_ORIGINS_ENV]) {
  const url = normalizeBaseUrl(input);
  const local = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ValidationError("Base URL must use HTTPS (HTTP is accepted only for localhost testing).");
  }
  const trusted = url.origin === CANONICAL_ORIGIN || local || deploymentTrustedOrigins(trustedOrigins).has(url.origin);
  if (!trusted) {
    throw new ValidationError(
      `Refusing to send the Account-SK to untrusted origin '${url.origin}'. A deployment administrator must add the exact origin to ${TRUSTED_ORIGINS_ENV}.`
    );
  }
  return url.toString();
}
function endpointUrl(baseUrl, endpoint, domain) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(endpoint)) {
    throw new ValidationError(`Invalid API endpoint '${endpoint}'.`);
  }
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  url.searchParams.set("domain", String(domain));
  return url;
}
function getCaseInsensitive(object, key) {
  const found = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found === void 0 ? void 0 : object[found];
}
function apiEnvelopeCode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const raw = getCaseInsensitive(value, "code");
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/u.test(raw)) return Number(raw);
  return void 0;
}
function apiEnvelopeData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  return getCaseInsensitive(value, "data");
}
function apiEnvelopeMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const raw = getCaseInsensitive(value, "message");
  return typeof raw === "string" && raw.trim() ? raw.trim() : void 0;
}
var SECRET_LOG_KEY = /(authorization|credential|api[-_]?key|token|secret|password|account[-_]?sk)/iu;
function redactLogValue(value, token, key) {
  if (key && SECRET_LOG_KEY.test(key)) return "[redacted secret]";
  if (key?.toLowerCase() === "image" && typeof value === "string") {
    return `[image data: ${value.length} characters]`;
  }
  if (typeof value === "string" && token && value.includes(token)) return "[redacted credential]";
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactLogValue(child, token, childKey)])
    );
  }
  return value;
}
function redactForLog(body, token) {
  return redactLogValue(body, token);
}
function redactText(value, token) {
  return token ? value.replaceAll(token, "[redacted credential]") : value;
}
function parseRetryAfter(value) {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1e3, 3e4));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return void 0;
  return Math.max(0, Math.min(date - Date.now(), 3e4));
}
async function wait(milliseconds, signal) {
  throwIfCancelled(signal);
  if (milliseconds <= 0) return;
  await new Promise((resolve3, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new NetworkError("Request cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve3();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function throwIfCancelled(signal) {
  if (signal?.aborted) throw new NetworkError("Request cancelled.");
}
async function readResponseText(response, maximumBytes) {
  if (maximumBytes === void 0) return response.text();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new NetworkError(`Sorftime API response exceeds the ${maximumBytes}-byte safety limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new NetworkError(`Sorftime API response exceeds the ${maximumBytes}-byte safety limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
async function parseResponse(response, maximumBytes) {
  const text = await readResponseText(response, maximumBytes);
  if (!text) return { value: null, raw: text, validJson: true };
  try {
    return { value: JSON.parse(text), raw: text, validJson: true };
  } catch {
    return { value: response.ok ? text : { raw: text }, raw: text, validJson: false };
  }
}
function timeoutSignal(timeoutMs, parent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    }
  };
}
async function requestApi(options, fetchImplementation = fetch) {
  throwIfCancelled(options.signal);
  const baseUrl = validateCredentialDestination(options.baseUrl);
  const url = endpointUrl(baseUrl, options.endpoint, options.domain);
  const maxAttempts = options.retries + 1;
  if (options.verbose) {
    process.stderr.write(`POST ${url.toString()}
${JSON.stringify(redactForLog(options.body, options.token))}
`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfCancelled(options.signal);
    const timed = timeoutSignal(options.timeoutMs, options.signal);
    try {
      throwIfCancelled(options.signal);
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          Authorization: `BasicAuth ${options.token}`,
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json",
          "User-Agent": options.userAgent ?? "sorftime-cli/1.0.0"
        },
        body: JSON.stringify(options.body),
        signal: timed.signal,
        redirect: "error"
      });
      if (timed.signal.aborted) throw timed.signal.reason ?? new Error("Request aborted");
      throwIfCancelled(options.signal);
      const parsed = await parseResponse(response, options.maxResponseBytes);
      if (timed.signal.aborted) throw timed.signal.reason ?? new Error("Request aborted");
      throwIfCancelled(options.signal);
      const payload = parsed.value;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxAttempts) {
          const delay = parseRetryAfter(response.headers.get("retry-after")) ?? 250 * 2 ** (attempt - 1);
          await wait(delay, options.signal);
          continue;
        }
        throw new NetworkError(
          `Sorftime API returned HTTP ${response.status} ${redactText(response.statusText, options.token)}.`,
          payload
        );
      }
      if (!parsed.validJson && !options.rawResponse) {
        throw new NetworkError("Sorftime API returned a non-JSON success response.");
      }
      const code = apiEnvelopeCode(payload);
      if (code !== void 0 && code !== 0) {
        const message = apiEnvelopeMessage(payload) ?? API_MESSAGES[code] ?? "Sorftime API returned a business error";
        throw new ApiError(`${redactText(message, options.token)} (code ${code}).`, code, payload);
      }
      return options.rawResponse ? parsed.raw : payload;
    } catch (error) {
      if (error instanceof ApiError || error instanceof NetworkError || error instanceof ValidationError) throw error;
      if (options.signal?.aborted) throw new NetworkError("Request cancelled.");
      if (attempt < maxAttempts) {
        await wait(250 * 2 ** (attempt - 1), options.signal);
        continue;
      }
      const message = timed.signal.aborted && !options.signal?.aborted ? `Request timed out after ${options.timeoutMs}ms.` : options.signal?.aborted ? "Request cancelled." : `Unable to reach Sorftime API: ${redactText(error instanceof Error ? error.message : String(error), options.token)}`;
      throw new NetworkError(message);
    } finally {
      timed.cleanup();
    }
  }
  throw new NetworkError("Sorftime API request failed.");
}

// src/config.ts
import { execFile as execFileCallback } from "child_process";
import { constants } from "fs";
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";

// src/types.ts
var OUTPUT_FORMATS = ["json", "jsonl", "yaml", "csv", "table", "raw"];

// src/config.ts
var execFile = promisify(execFileCallback);
var KEYCHAIN_SERVICE = "com.sorftime.cli";
var KEYCHAIN_ACCOUNT = "account-sk";
function configDirectory(env = process.env) {
  return env.SORFTIME_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sorftime");
}
function configPath(env = process.env) {
  return join(configDirectory(env), "config.json");
}
function credentialsPath(env = process.env) {
  return join(configDirectory(env), "credentials.json");
}
async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new ValidationError(`Invalid JSON in ${path}.`);
    throw error;
  }
}
var SECRET_CONFIG_KEY = /(authorization|token|secret|password|account[-_]?sk)/iu;
function normalizeStoredConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Sorftime config must be a JSON object.");
  }
  const raw = value;
  const secretKey = Object.keys(raw).find((key) => SECRET_CONFIG_KEY.test(key));
  if (secretKey) {
    throw new ValidationError(`Secret-like key '${secretKey}' is not allowed in config.json. Remove it and use 'sorftime-team auth login'.`);
  }
  const config = {};
  if (raw.domain !== void 0) {
    if (typeof raw.domain !== "string" && typeof raw.domain !== "number") throw new ValidationError("Config domain must be a string or number.");
    config.domain = raw.domain;
  }
  if (raw.baseUrl !== void 0) {
    if (typeof raw.baseUrl !== "string") throw new ValidationError("Config baseUrl must be a string.");
    config.baseUrl = raw.baseUrl;
  }
  if (raw.timeoutMs !== void 0) {
    if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) throw new ValidationError("Config timeoutMs must be a positive integer.");
    config.timeoutMs = raw.timeoutMs;
  }
  if (raw.output !== void 0) {
    if (typeof raw.output !== "string" || !OUTPUT_FORMATS.includes(raw.output)) {
      throw new ValidationError("Config output format is invalid.");
    }
    config.output = raw.output;
  }
  return config;
}
async function atomicWriteJson(path, value, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}
async function loadConfig(env = process.env) {
  return normalizeStoredConfig(await readJsonFile(configPath(env), {}));
}
async function saveConfig(config, env = process.env) {
  await atomicWriteJson(configPath(env), normalizeStoredConfig(config), 384);
}
async function hasSecurityCommand(env = process.env) {
  if (process.platform !== "darwin" || env.SORFTIME_CREDENTIAL_STORE === "file") return false;
  try {
    await access("/usr/bin/security", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function readKeychainToken(env = process.env) {
  if (!await hasSecurityCommand(env)) return void 0;
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w"
    ]);
    return stdout.trim() || void 0;
  } catch {
    return void 0;
  }
}
async function readFileToken(env) {
  const path = credentialsPath(env);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new ValidationError(`Credential file ${path} must not be a symbolic link.`);
  }
  if (!metadata.isFile()) {
    throw new ValidationError(`Credential path ${path} must be a regular file.`);
  }
  if (process.platform !== "win32" && (metadata.mode & 63) !== 0) {
    throw new ValidationError(`Credential file ${path} has unsafe permissions; run chmod 600 on it.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new ValidationError(`Credential file ${path} is not owned by the current user.`);
  }
  const credentials = await readJsonFile(path, {});
  return credentials.accountSk?.trim() || void 0;
}
async function resolveToken(env = process.env) {
  if (env.SORFTIME_ACCOUNT_SK?.trim()) return { token: env.SORFTIME_ACCOUNT_SK.trim(), source: "environment" };
  const keychain = await readKeychainToken(env);
  if (keychain) return { token: keychain, source: "keychain" };
  const file = await readFileToken(env);
  if (file) return { token: file, source: "file" };
  return { source: "missing" };
}
async function saveToken(token, env = process.env) {
  const cleaned = token.trim();
  if (!cleaned) throw new ValidationError("Account-SK cannot be empty.");
  if (/[\r\n]/u.test(cleaned)) throw new ValidationError("Account-SK cannot contain line breaks.");
  await atomicWriteJson(credentialsPath(env), { accountSk: cleaned }, 384);
  return "file";
}
async function deleteToken(env = process.env) {
  let deleted = false;
  if (await hasSecurityCommand(env)) {
    try {
      await execFile("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE
      ]);
      deleted = true;
    } catch {
    }
  }
  try {
    await unlink(credentialsPath(env));
    deleted = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return deleted;
}

// src/domains.ts
var DOMAINS = [
  { id: 1, code: "US", name: "United States", aliases: ["us", "usa", "\u7F8E\u56FD"], historyBackfill: true },
  { id: 2, code: "GB", name: "United Kingdom", aliases: ["gb", "uk", "\u82F1\u56FD"], historyBackfill: true },
  { id: 3, code: "DE", name: "Germany", aliases: ["de", "germany", "\u5FB7\u56FD"], historyBackfill: true },
  { id: 4, code: "FR", name: "France", aliases: ["fr", "france", "\u6CD5\u56FD"], historyBackfill: true },
  { id: 5, code: "IN", name: "India", aliases: ["in", "india", "\u5370\u5EA6"], historyBackfill: false },
  { id: 6, code: "CA", name: "Canada", aliases: ["ca", "canada", "\u52A0\u62FF\u5927"], historyBackfill: true },
  { id: 7, code: "JP", name: "Japan", aliases: ["jp", "japan", "\u65E5\u672C"], historyBackfill: true },
  { id: 8, code: "ES", name: "Spain", aliases: ["es", "spain", "\u897F\u73ED\u7259"], historyBackfill: true },
  { id: 9, code: "IT", name: "Italy", aliases: ["it", "italy", "\u610F\u5927\u5229"], historyBackfill: true },
  { id: 10, code: "MX", name: "Mexico", aliases: ["mx", "mexico", "\u58A8\u897F\u54E5"], historyBackfill: true },
  { id: 11, code: "AE", name: "United Arab Emirates", aliases: ["ae", "uae", "\u963F\u8054\u914B"], historyBackfill: false },
  { id: 12, code: "AU", name: "Australia", aliases: ["au", "australia", "\u6FB3\u5927\u5229\u4E9A"], historyBackfill: false },
  { id: 13, code: "BR", name: "Brazil", aliases: ["br", "brazil", "\u5DF4\u897F"], historyBackfill: false },
  { id: 14, code: "SA", name: "Saudi Arabia", aliases: ["sa", "ksa", "saudi", "\u6C99\u7279\u963F\u62C9\u4F2F"], historyBackfill: false }
];
function resolveDomain(input) {
  const value = String(input ?? "us").trim().toLowerCase();
  const numeric = Number(value);
  const domain = DOMAINS.find(
    (item) => item.id === numeric || item.code.toLowerCase() === value || item.aliases.includes(value)
  );
  if (!domain) {
    throw new ValidationError(`Unsupported domain '${String(input)}'. Run 'sorftime-team domains' to list valid values.`);
  }
  return domain;
}

// src/endpoints.ts
var p = (key, type, description, options = {}) => ({ key, type, description, ...options });
var asin = (key = "ASIN", type = "string") => p(key, type, "Amazon ASIN", { required: true, variadic: type === "string[]" });
var nodeId = () => p("NodeId", "string", "Amazon category node ID", { required: true });
var page = () => p("Page", "integer", "Page number (starts at 1)", { min: 1 });
var pageIndex = () => p("PageIndex", "integer", "Page number (starts at 1)", { min: 1 });
var pageSize = () => p("PageSize", "integer", "Rows per page (20-200)", { min: 20, max: 200 });
var taskId = () => p("TaskId", "string", "Task ID", { required: true });
var scheduleId = () => p("ScheduleId", "string", "Execution batch/schedule ID", { required: true });
var queryDate = (required = false) => p("QueryDate", "string", "Query date (YYYY-MM-DD)", { required, format: "date" });
var dataPagination = (pageKey, defaultPageSize, pageSizeKey) => ({
  pageKey,
  ...pageSizeKey ? { pageSizeKey } : {},
  defaultPageSize,
  rowPath: ["Data"],
  termination: "empty-page"
});
var ENDPOINTS = [
  {
    name: "CategoryTree",
    group: "category",
    command: "tree",
    summary: "Fetch the full Amazon Best Sellers category tree",
    cost: "5 requests",
    // Measured live 2026-09-03 on US: 6m33s, 10.4 MB, 35,126 nodes. The previous 300s default
    // timed out. Larger marketplaces have headroom here; always write the result to a file.
    parameters: [],
    timeoutMs: 9e5
  },
  {
    name: "CategoryRequest",
    group: "category",
    command: "best-sellers",
    summary: "Fetch category Top 100 Best Sellers, optionally with history",
    cost: "5 realtime; 10 per historical 3-day block",
    parameters: [
      nodeId(),
      p("QueryStart", "string", "Historical range start (YYYY-MM-DD)", { format: "date" }),
      queryDate(),
      p("QueryDays", "integer", "Legacy number of days before QueryDate", { min: 1 })
    ],
    history: { mode: "when-fields-present", fields: ["QueryStart", "QueryDate", "QueryDays"] },
    dateRanges: [{ startKey: "QueryStart", endKey: "QueryDate" }]
  },
  {
    name: "CategoryProducts",
    group: "category",
    command: "products",
    summary: "Fetch hot products in a category",
    cost: "5 requests",
    parameters: [nodeId(), page(), p("Range", "integer", "Keep the top N products by monthly sales", { min: 1 })],
    pagination: { ...dataPagination("Page", 100), rowPath: ["Data", "Products"] }
  },
  {
    name: "CategoryTrend",
    group: "category",
    command: "trend",
    summary: "Fetch up to two years of category trend data",
    cost: "5 requests",
    parameters: [
      nodeId(),
      p("TrendIndex", "integer", "Trend metric index (0-15)", { required: true, min: 0, max: 15 })
    ],
    history: { mode: "always" }
  },
  {
    name: "ProductRequest",
    group: "product",
    command: "get",
    summary: "Fetch product details and optional trend data",
    cost: "1 per ASIN; 2 for trends longer than 15 days",
    parameters: [
      // Verified live 2026-09-03: a JSON array returns Code 0 with Data null and no charge,
      // for one ASIN and for several. Only a comma-separated string returns data. The source
      // documentation's batch-array example is wrong; do not restore the array encoding.
      { ...asin("ASIN", "string[]"), wire: "csv", description: "Amazon ASIN; repeatable, up to 10" },
      p("Trend", "integer", "1 includes trend data; 2 excludes it", { choices: [1, 2] }),
      p("QueryTrendStartDt", "string", "Trend range start (YYYY-MM-DD)", { format: "date" }),
      p("QueryTrendEndDt", "string", "Trend range end (YYYY-MM-DD)", { format: "date" })
    ],
    history: { mode: "when-fields-present", fields: ["QueryTrendStartDt", "QueryTrendEndDt"] },
    dateRanges: [{ startKey: "QueryTrendStartDt", endKey: "QueryTrendEndDt" }]
  },
  {
    name: "ProductQuery",
    group: "product",
    command: "search",
    summary: "Search products by one or multiple conditions",
    cost: "5 requests",
    parameters: [
      page(),
      p("Query", "integer", "1 single condition; 2 multi-condition AND", { choices: [1, 2] }),
      p("QueryType", "string", "Single-condition query type (1-16)", {
        choices: Array.from({ length: 16 }, (_, index) => String(index + 1))
      }),
      p("Pattern", "string", "Search value for QueryType")
    ]
  },
  {
    name: "AsinSalesVolume",
    group: "product",
    command: "sales-volume",
    summary: "Fetch officially published child-ASIN sales history",
    cost: "1 request",
    parameters: [
      asin(),
      page(),
      queryDate(),
      p("QueryEndDate", "string", "Range end (YYYY-MM-DD)", { format: "date" })
    ],
    pagination: dataPagination("Page", 100),
    history: { mode: "when-fields-present", fields: ["QueryDate", "QueryEndDate"] },
    dateRanges: [{ startKey: "QueryDate", endKey: "QueryEndDate" }]
  },
  {
    name: "ProductVariationHistory",
    group: "product",
    command: "variation-history",
    summary: "Fetch recent variation changes for a listing",
    cost: "1 request",
    parameters: [asin()]
  },
  {
    name: "ProductRealtimeRequest",
    group: "product",
    command: "realtime-start",
    summary: "Start a realtime product crawl",
    cost: "1 request; JP 2",
    parameters: [asin(), p("Update", "integer", "Reuse data newer than this many hours (1-120)", { min: 1, max: 120 })],
    unsafeRetry: true
  },
  {
    name: "ProductRealtimeRequestStatusQuery",
    group: "product",
    command: "realtime-status",
    summary: "List realtime product crawl tasks created on a date",
    cost: "1 request",
    parameters: [queryDate(true)]
  },
  {
    name: "ProductReviewsCollection",
    group: "product",
    command: "reviews-collect",
    summary: "Start an asynchronous review collection task",
    cost: "2 coin points per 10 reviews; minimum 2",
    parameters: [
      asin(),
      p("Mode", "integer", "0 top reviews; 1 most recent", { required: true, choices: [0, 1] }),
      p("Star", "string", "Comma-separated star filters: 1-5, 10 negative, 11 positive"),
      p("OnlyPurchase", "integer", "1 collects verified-purchase reviews only", { choices: [1] }),
      page()
    ],
    unsafeRetry: true
  },
  {
    name: "ProductReviewsCollectionStatusQuery",
    group: "product",
    command: "reviews-status",
    summary: "Query review collection status",
    cost: "free",
    parameters: [asin(), p("Update", "integer", "Look back this many hours (1-240)", { min: 1, max: 240 })]
  },
  {
    name: "ProductReviewsQuery",
    group: "product",
    command: "reviews-list",
    summary: "Fetch collected product reviews",
    cost: "5 requests",
    parameters: [
      asin(),
      p("Querystartdt", "string", "Review range start (YYYY-MM-DD)", { format: "date" }),
      pageIndex(),
      p("Star", "string", "Comma-separated star filters: 1-5, 10 negative, 11 positive"),
      p("OnlyPurchase", "integer", "0 all; 1 verified-purchase only", { choices: [0, 1] })
    ],
    pagination: dataPagination("PageIndex", 100)
  },
  {
    name: "SimilarProductRealtimeRequest",
    group: "product",
    command: "similar-start",
    summary: "Start an image-based similar-product search",
    cost: "5 requests; JP 6",
    parameters: [p("Image", "image", "Image data URL, or @/path/to/image", { required: true })],
    timeoutMs: 12e4,
    unsafeRetry: true
  },
  {
    name: "SimilarProductRealtimeRequestStatusQuery",
    group: "product",
    command: "similar-status",
    summary: "Query image-search task status",
    cost: "free",
    parameters: [p("Update", "integer", "Look back this many hours (1-240)", { min: 1, max: 240 })]
  },
  {
    name: "SimilarProductRealtimeRequestCollection",
    group: "product",
    command: "similar-results",
    summary: "Fetch image-search results",
    cost: "free",
    parameters: [taskId()]
  },
  {
    name: "KeywordQuery",
    group: "keyword",
    command: "list",
    summary: "List current Amazon Brand Analytics keywords",
    cost: "5 requests",
    parameters: [
      p("Pattern", "json", "KeywordQueryPattern JSON object", {
        required: true,
        sourceOptionalButRuntimeRequired: true
      }),
      pageIndex(),
      pageSize()
    ],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "KeywordSearchResults",
    group: "keyword",
    command: "search-results",
    summary: "Fetch recent search-result products for an ABA keyword",
    cost: "5 requests",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true }), pageIndex(), pageSize()],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "KeywordRequest",
    group: "keyword",
    command: "get",
    summary: "Fetch keyword details, search volume and CPC trend",
    cost: "1 request",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true })]
  },
  {
    name: "KeywordSearchResultTrend",
    group: "keyword",
    command: "search-trend",
    summary: "Fetch product-statistics trend for the first three result pages",
    cost: "10 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }),
      p("QueryStart", "string", "Start month (YYYY-MM)", { format: "month" }),
      p("QueryEnd", "string", "End month (YYYY-MM)", { format: "month" })
    ],
    history: { mode: "always" },
    dateRanges: [{ startKey: "QueryStart", endKey: "QueryEnd" }]
  },
  {
    name: "CategoryRequestKeyword",
    group: "keyword",
    command: "by-category",
    summary: "Find ABA keywords associated with a leaf category",
    cost: "1 request",
    parameters: [nodeId(), pageIndex(), pageSize()],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "ASINRequestKeyword",
    group: "keyword",
    command: "by-asin",
    summary: "Find keywords where an ASIN ranked in the first three pages",
    cost: "1 request",
    parameters: [asin(), pageIndex(), pageSize()],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "KeywordProductRanking",
    group: "keyword",
    command: "product-ranking",
    summary: "Fetch historical monthly keyword result products",
    cost: "5 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }),
      p("Month", "string", "Historical month (YYYY-MM; required on US)", {
        format: "month",
        requiredWhen: {
          marketplaces: ["US"],
          reason: "the API rejects KeywordProductRanking without Month on the US marketplace"
        }
      }),
      page()
    ],
    pagination: dataPagination("Page", 200),
    history: { mode: "when-fields-present", fields: ["Month"] }
  },
  {
    name: "ASINKeywordRanking",
    group: "keyword",
    command: "asin-ranking",
    summary: "Fetch an ASIN's rank trend for a keyword",
    cost: "2 requests",
    parameters: [
      p("Keyword", "string", "ABA keyword", { required: true }),
      asin(),
      p("QueryStart", "string", "Range start (YYYY-MM-DD)", { format: "date" }),
      p("QueryEnd", "string", "Range end (YYYY-MM-DD)", { format: "date" }),
      page()
    ],
    pagination: dataPagination("Page", 200),
    history: { mode: "when-fields-present", fields: ["QueryStart", "QueryEnd"] },
    dateRanges: [{ startKey: "QueryStart", endKey: "QueryEnd" }]
  },
  {
    name: "KeywordExtends",
    group: "keyword",
    command: "extend",
    summary: "Fetch related ABA keywords",
    cost: "5 requests",
    parameters: [p("Keyword", "string", "ABA keyword", { required: true }), pageIndex(), pageSize()],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "FavoriteKeyword",
    group: "keyword",
    command: "favorite-add",
    summary: "Add a keyword to the API personal dictionary",
    cost: "1 request",
    parameters: [
      p("Keyword", "string", "Keyword to save", { required: true }),
      p("Dict", "string", "Dictionary/folder name (created if absent)")
    ],
    unsafeRetry: true
  },
  {
    name: "ChangeFavoriteKeyword",
    group: "keyword",
    command: "favorite-change",
    summary: "Move or delete a personal-dictionary keyword",
    cost: "1 request",
    parameters: [],
    undocumentedParameters: true,
    unsafeRetry: true
  },
  {
    name: "GetFavoriteKeyword",
    group: "keyword",
    command: "favorite-list",
    summary: "List personal-dictionary keywords",
    cost: "unknown",
    parameters: [],
    undocumentedParameters: true
  },
  {
    name: "KeywordBatchSubscription",
    group: "monitor",
    command: "keyword-create",
    summary: "Create keyword-ranking monitor tasks",
    cost: "free API call; monitoring uses coin points",
    parameters: [
      p("Keyword", "string[]", "Keyword to monitor (repeatable)", { required: true, variadic: true }),
      p("Mode", "integer", "0 desktop; 1 mobile", { required: true, choices: [0, 1] }),
      p("Area", "string", "Postal code/area (required for desktop mode)"),
      page(),
      p("Period", "string", "Monitoring period expression, e.g. 1|1|1")
    ],
    unsafeRetry: true
  },
  {
    name: "KeywordTasks",
    group: "monitor",
    command: "keyword-list",
    summary: "List active keyword monitor tasks",
    cost: "free",
    parameters: [
      p("Keyword", "string", "Fuzzy keyword filter"),
      p("TaskId", "string", "Comma-separated task IDs"),
      pageIndex(),
      pageSize()
    ],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "KeywordBatchTaskUpdate",
    group: "monitor",
    command: "keyword-update",
    summary: "Modify, pause, start or delete a keyword monitor task",
    cost: "free API call; Update=2 resumes coin monitoring",
    parameters: [
      p("TaskId", "integer", "Keyword monitor task ID", { required: true }),
      p("Update", "integer", "0 modify; 1 pause; 2 start; 9 delete", { required: true, choices: [0, 1, 2, 9] }),
      p("Mode", "integer", "0 desktop; 1 mobile", { choices: [0, 1] }),
      p("Area", "string", "Postal code/area"),
      page(),
      p("Period", "string", "Monitoring period expression")
    ],
    unsafeRetry: true
  },
  {
    name: "KeywordBatchScheduleList",
    group: "monitor",
    command: "keyword-runs",
    summary: "List keyword monitor execution batches",
    cost: "free",
    parameters: [p("TaskId", "string", "Keyword monitor task ID", { required: true }), queryDate()]
  },
  {
    name: "KeywordBatchScheduleDetail",
    group: "monitor",
    command: "keyword-run-data",
    summary: "Fetch keyword monitor execution details",
    cost: "free",
    parameters: [scheduleId()]
  },
  {
    name: "BestSellerListSubscription",
    group: "monitor",
    command: "best-seller-create",
    summary: "Create or modify a Best Seller list monitor",
    cost: "free API call; 10-40 points/day",
    parameters: [
      nodeId(),
      p("Range", "integer", "Monitoring depth; 1 means Top 100", { min: 1 }),
      p("Period", "integer", "100/106/112/118 daily or 200/201 every two hours", { required: true, choices: [100, 106, 112, 118, 200, 201] }),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] })
    ],
    unsafeRetry: true
  },
  {
    name: "BestSellerListTask",
    group: "monitor",
    command: "best-seller-list",
    summary: "List Best Seller monitor tasks",
    cost: "free",
    parameters: [pageIndex(), pageSize()],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "BestSellerListDelete",
    group: "monitor",
    command: "best-seller-delete",
    summary: "Delete a Best Seller monitor",
    cost: "free",
    parameters: [
      nodeId(),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] })
    ],
    unsafeRetry: true
  },
  {
    name: "BestSellerListDataCollect",
    group: "monitor",
    command: "best-seller-data",
    summary: "Fetch monitored Best Seller list data",
    cost: "free",
    parameters: [
      nodeId(),
      p("BestSellerListType", "integer", "1 New Releases; 3 Most Wished; 4 Gift Ideas; 5 Best Sellers", { required: true, choices: [1, 3, 4, 5] }),
      p("QueryDate", "string", "Data time (YYYY-MM-DD HH)", { required: true, format: "date-hour" })
    ]
  },
  {
    name: "ProductSellerSubscription",
    group: "monitor",
    command: "seller-create",
    summary: "Create a seller and stock monitor",
    cost: "2 points/ASIN/period; JP 4; stock extra",
    parameters: [
      asin("Asin"),
      p("CheckStock", "integer", "0 do not check stock; 1 check stock", { choices: [0, 1] }),
      p("Period", "string", "Monitoring period expression, e.g. 1|1|1", { required: true })
    ],
    unsafeRetry: true
  },
  {
    name: "ProductSellerTasks",
    group: "monitor",
    command: "seller-list",
    summary: "List seller and stock monitor tasks",
    cost: "free",
    parameters: [],
    undocumentedParameters: true
  },
  {
    name: "ProductSellerTaskUpdate",
    group: "monitor",
    command: "seller-update",
    summary: "Update a seller and stock monitor task",
    cost: "free API call; may change coin monitoring",
    parameters: [],
    undocumentedParameters: true,
    unsafeRetry: true
  },
  {
    name: "ProductSellerTaskScheduleList",
    group: "monitor",
    command: "seller-runs",
    summary: "List seller/stock monitor execution batches",
    cost: "free",
    parameters: [p("TaskId", "string", "Seller monitor task ID", { required: true })]
  },
  {
    name: "ProductSellerTaskScheduleDetail",
    group: "monitor",
    command: "seller-run-data",
    summary: "Fetch seller/stock monitor execution details",
    cost: "free",
    parameters: [scheduleId()]
  },
  {
    name: "ASINSubscription",
    group: "monitor",
    command: "asin-update",
    summary: "Add or remove daily ASIN update subscriptions",
    cost: "1 point/successful update; JP 2",
    parameters: [p("Asins", "string", "Subscription expression: +/-,ASIN,1 (max 100 ASINs)", { required: true })],
    unsafeRetry: true
  },
  {
    name: "ASINSubscriptionQuery",
    group: "monitor",
    command: "asin-list",
    summary: "List active ASIN update subscriptions",
    cost: "free",
    parameters: []
  },
  {
    name: "ASINSubscriptionCollection",
    group: "monitor",
    command: "asin-data",
    summary: "Fetch updated data for active ASIN subscriptions",
    cost: "free",
    parameters: [p("Asins", "string", "Comma-separated subscribed ASINs (max 100)", { required: true })]
  },
  {
    name: "ProductAssistant",
    group: "agent",
    command: "product",
    summary: "Start AI analysis for a product",
    cost: "25 requests",
    parameters: [asin("Asin"), p("Type", "integer", "0 Markdown text; 1 text plus HTML graphics", { required: true, choices: [0, 1] })],
    unsafeRetry: true
  },
  {
    name: "CategoryAssistant",
    group: "agent",
    command: "category",
    summary: "Start AI analysis for a category",
    cost: "25 requests",
    parameters: [nodeId(), p("Type", "integer", "0 Markdown text; 1 text plus HTML graphics", { required: true, choices: [0, 1] })],
    unsafeRetry: true
  },
  {
    name: "AIResultQuery",
    group: "agent",
    command: "status",
    summary: "List AI tasks and execution progress",
    cost: "1 request",
    parameters: [
      p("Method", "integer", "0 product analysis; 1 category analysis", { required: true, choices: [0, 1] }),
      p("Params", "string", "ASIN or NodeId filter"),
      p("QueryStart", "string", "Range start (YYYY-MM-DD; max 7 calendar days)", {
        required: true,
        sourceOptionalButRuntimeRequired: true,
        format: "date"
      }),
      p("QueryEnd", "string", "Range end (YYYY-MM-DD)", {
        required: true,
        sourceOptionalButRuntimeRequired: true,
        format: "date"
      })
    ],
    dateRanges: [{ startKey: "QueryStart", endKey: "QueryEnd", maxCalendarDays: 7 }]
  },
  {
    name: "AIResult",
    group: "agent",
    command: "result",
    summary: "Fetch a completed AI analysis result",
    cost: "free",
    parameters: [taskId()]
  },
  {
    name: "CoinQuery",
    group: "account",
    command: "coins",
    summary: "Show the account's global coin balance",
    cost: "free",
    parameters: []
  },
  {
    name: "CoinStream",
    group: "account",
    command: "coin-stream",
    summary: "Fetch coin usage details for a marketplace",
    cost: "free",
    parameters: [
      p("QueryDate", "string[]", "Date range: --query-date START --query-date END", {
        variadic: true,
        format: "date"
      }),
      pageIndex(),
      pageSize()
    ],
    pagination: dataPagination("PageIndex", 20, "PageSize")
  },
  {
    name: "RequestStreamMonth",
    group: "account",
    command: "request-stream",
    summary: "Show monthly request balance and recent usage",
    cost: "free",
    parameters: []
  }
];
function findEndpoint(name) {
  const normalized = name.toLowerCase();
  const exact = ENDPOINTS.find(
    (endpoint) => endpoint.name.toLowerCase() === normalized || endpoint.aliases?.some((alias) => alias.toLowerCase() === normalized)
  );
  if (exact) return exact;
  const commandMatches = ENDPOINTS.filter((endpoint) => endpoint.command.toLowerCase() === normalized);
  return commandMatches.length === 1 ? commandMatches[0] : void 0;
}

// src/input.ts
import { readFile as readFile2, stat } from "fs/promises";
import { extname, resolve } from "path";
import { stdin } from "process";
var MAX_JSON_BYTES = 25 * 1024 * 1024;
var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function optionName(key) {
  return key.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2").toLowerCase();
}
function commanderProperty(key) {
  const name = optionName(key);
  return name.replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Interrupted");
}
async function readLimitedFile(path, signal) {
  throwIfAborted(signal);
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  throwIfAborted(signal);
  if (metadata.size > MAX_JSON_BYTES) {
    throw new ValidationError(`Input file exceeds the ${MAX_JSON_BYTES / 1024 / 1024}MB limit.`);
  }
  const buffer = await readFile2(absolute, signal ? { signal } : void 0);
  throwIfAborted(signal);
  return buffer.toString("utf8");
}
async function readStdin(signal) {
  throwIfAborted(signal);
  return new Promise((resolveInput, rejectInput) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_JSON_BYTES) {
        cleanup();
        stdin.pause();
        rejectInput(new ValidationError(`Standard input exceeds the ${MAX_JSON_BYTES / 1024 / 1024}MB limit.`));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolveInput(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error) => {
      cleanup();
      rejectInput(error);
    };
    const onAbort = () => {
      cleanup();
      stdin.pause();
      rejectInput(signal?.reason ?? new Error("Interrupted"));
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.resume();
  });
}
function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError(`Invalid JSON in ${label}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must contain a JSON object.`);
  }
  return value;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function validateFormat(value, parameter) {
  if (parameter.format === "date" && !validDate(value)) {
    throw new ValidationError(`--${optionName(parameter.key)} must be a valid date in YYYY-MM-DD format.`);
  }
  if (parameter.format === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new ValidationError(`--${optionName(parameter.key)} must use YYYY-MM format.`);
  }
  if (parameter.format === "date-hour") {
    const match = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3])$/u.exec(value);
    if (!match?.[1] || !validDate(match[1])) {
      throw new ValidationError(`--${optionName(parameter.key)} must use YYYY-MM-DD HH format.`);
    }
  }
}
function parseNumber(value, integer, parameter) {
  if (typeof value === "number") {
    if (integer && !Number.isInteger(value)) throw new ValidationError(`${parameter.key} must be an integer.`);
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${parameter.key} must be a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || integer && !Number.isInteger(parsed)) {
    throw new ValidationError(`${parameter.key} must be ${integer ? "an integer" : "a number"}.`);
  }
  return parsed;
}
function mimeForPath(path) {
  const extension = extname(path).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[extension] ?? "application/octet-stream";
}
async function coerceValue(raw, parameter, signal) {
  throwIfAborted(signal);
  if (parameter.type === "integer" || parameter.type === "number") {
    const value2 = parseNumber(raw, parameter.type === "integer", parameter);
    if (parameter.min !== void 0 && value2 < parameter.min) {
      throw new ValidationError(`${parameter.key} must be at least ${parameter.min}.`);
    }
    if (parameter.max !== void 0 && value2 > parameter.max) {
      throw new ValidationError(`${parameter.key} must be at most ${parameter.max}.`);
    }
    if (parameter.choices && !parameter.choices.includes(value2)) {
      throw new ValidationError(`${parameter.key} must be one of: ${parameter.choices.join(", ")}.`);
    }
    return value2;
  }
  if (parameter.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const value2 = String(raw).toLowerCase();
    if (["true", "1", "yes"].includes(value2)) return true;
    if (["false", "0", "no"].includes(value2)) return false;
    throw new ValidationError(`${parameter.key} must be true or false.`);
  }
  if (parameter.type === "string[]") {
    const values = Array.isArray(raw) ? raw : [raw];
    const items = values.flatMap((value2) => String(value2).split(",")).map((value2) => value2.trim()).filter(Boolean);
    for (const item of items) validateFormat(item, parameter);
    return parameter.wire === "csv" ? items.join(",") : items;
  }
  if (parameter.type === "json") {
    if (typeof raw !== "string") return raw;
    const text = raw.startsWith("@") ? await readLimitedFile(raw.slice(1), signal) : raw;
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError(`Invalid JSON for ${parameter.key}.`);
    }
  }
  if (parameter.type === "image") {
    const value2 = String(raw);
    if (!value2.startsWith("@")) return value2;
    const path = value2.slice(1);
    const absolute = resolve(path);
    const metadata = await stat(absolute);
    throwIfAborted(signal);
    if (metadata.size > MAX_IMAGE_BYTES) {
      throw new ValidationError(`Image file exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB safety limit.`);
    }
    const buffer = await readFile2(absolute, signal ? { signal } : void 0);
    throwIfAborted(signal);
    return `data:${mimeForPath(path)};base64,${buffer.toString("base64")}`;
  }
  const value = String(raw);
  validateFormat(value, parameter);
  if (parameter.choices && !parameter.choices.includes(value)) {
    throw new ValidationError(`${parameter.key} must be one of: ${parameter.choices.join(", ")}.`);
  }
  return value;
}
async function buildRequestBody(endpoint, commandOptions, marketplace, signal) {
  throwIfAborted(signal);
  const input = {
    ...typeof commandOptions.data === "string" ? { data: commandOptions.data } : {},
    ...typeof commandOptions.dataFile === "string" ? { dataFile: commandOptions.dataFile } : {},
    ...commandOptions.stdin === true ? { stdin: true } : {}
  };
  const rawModes = [input.data !== void 0, input.dataFile !== void 0, input.stdin].filter(Boolean).length;
  if (rawModes > 1) throw new ValidationError("Use only one of --data, --data-file, or --stdin.");
  let body = {};
  if (input.data !== void 0) body = parseJsonObject(input.data, "--data");
  if (input.dataFile !== void 0) body = parseJsonObject(await readLimitedFile(input.dataFile, signal), input.dataFile);
  if (input.stdin) body = parseJsonObject(await readStdin(signal), "standard input");
  for (const parameter of endpoint.parameters) {
    const raw = commandOptions[commanderProperty(parameter.key)];
    if (raw !== void 0) body[parameter.key] = await coerceValue(raw, parameter, signal);
  }
  for (const parameter of endpoint.parameters) {
    const required = parameter.required === true || (parameter.requiredWhen?.marketplaces.includes((marketplace ?? "US").toUpperCase()) ?? false);
    const initialValue = body[parameter.key];
    if (required && isEmptyRequiredValue(initialValue)) {
      const reason = parameter.requiredWhen ? ` ${parameter.requiredWhen.reason}.` : "";
      throw new ValidationError(
        `Missing required option --${optionName(parameter.key)} (or provide ${parameter.key} in raw JSON).${reason}`
      );
    }
    if (initialValue === null) throw new ValidationError(`${parameter.key} cannot be null.`);
    if (initialValue !== void 0) body[parameter.key] = await coerceValue(initialValue, parameter, signal);
    if (required && isEmptyRequiredValue(body[parameter.key])) {
      const reason = parameter.requiredWhen ? ` ${parameter.requiredWhen.reason}.` : "";
      throw new ValidationError(
        `Missing required option --${optionName(parameter.key)} (or provide ${parameter.key} in raw JSON).${reason}`
      );
    }
  }
  validateEndpointBody(endpoint, body);
  throwIfAborted(signal);
  return body;
}
function isEmptyRequiredValue(value) {
  return value === void 0 || value === null || typeof value === "string" && value.trim() === "" || Array.isArray(value) && value.length === 0;
}
function dateOrdinal(value) {
  if (typeof value !== "string") return void 0;
  const normalized = /^\d{4}-\d{2}$/u.test(value) ? `${value}-01` : value;
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed) ? void 0 : parsed;
}
function validateDateRanges(endpoint, body) {
  for (const range of endpoint.dateRanges ?? []) {
    const start = dateOrdinal(body[range.startKey]);
    const end = dateOrdinal(body[range.endKey]);
    if (start === void 0 || end === void 0) continue;
    if (start > end) {
      throw new ValidationError(`${range.startKey} must not be after ${range.endKey}.`);
    }
    if (range.maxCalendarDays !== void 0) {
      const calendarDays = Math.floor((end - start) / 864e5) + 1;
      if (calendarDays > range.maxCalendarDays) {
        throw new ValidationError(
          `${range.startKey} through ${range.endKey} may span at most ${range.maxCalendarDays} calendar days.`
        );
      }
    }
  }
}
function validateEndpointBody(endpoint, body) {
  validateDateRanges(endpoint, body);
  if (endpoint.name === "ProductRequest" && body.ASIN !== void 0) {
    const count = Array.isArray(body.ASIN) ? body.ASIN.length : String(body.ASIN).split(",").filter((part) => part.trim().length > 0).length;
    if (count > 10) throw new ValidationError("ProductRequest accepts at most 10 ASINs per call.");
  }
  if (endpoint.name === "ProductQuery" && (body.Query === void 0 || body.Query === 1)) {
    if (body.QueryType === void 0 || body.Pattern === void 0) {
      throw new ValidationError("ProductQuery single-condition mode requires --query-type and --pattern.");
    }
  }
  if (endpoint.name === "KeywordBatchSubscription" && body.Mode === 0 && !body.Area) {
    throw new ValidationError("Desktop keyword monitoring (--mode 0) requires --area.");
  }
  if (endpoint.name === "CoinStream" && Array.isArray(body.QueryDate) && body.QueryDate.length !== 2) {
    throw new ValidationError("CoinStream --query-date requires exactly two values: start and end.");
  }
  if (endpoint.name === "CoinStream" && Array.isArray(body.QueryDate) && body.QueryDate.length === 2) {
    const start = dateOrdinal(body.QueryDate[0]);
    const end = dateOrdinal(body.QueryDate[1]);
    if (start !== void 0 && end !== void 0 && start > end) {
      throw new ValidationError("CoinStream QueryDate start must not be after end.");
    }
  }
  if (endpoint.name === "ProductRequest" && body.QueryTrendEndDt !== void 0 && body.QueryTrendStartDt === void 0) {
    throw new ValidationError("--query-trend-end-dt requires --query-trend-start-dt.");
  }
}

// src/policy.ts
var ENDPOINT_BILLING = {
  // Category market
  CategoryTree: "request",
  CategoryRequest: "request",
  CategoryProducts: "request",
  CategoryTrend: "request",
  // Product
  ProductRequest: "request",
  ProductQuery: "request",
  AsinSalesVolume: "request",
  ProductVariationHistory: "request",
  ProductRealtimeRequest: "request",
  ProductRealtimeRequestStatusQuery: "request",
  ProductReviewsCollection: "coin",
  ProductReviewsCollectionStatusQuery: "free",
  ProductReviewsQuery: "request",
  SimilarProductRealtimeRequest: "request",
  SimilarProductRealtimeRequestStatusQuery: "free",
  SimilarProductRealtimeRequestCollection: "free",
  // Keywords
  KeywordQuery: "request",
  KeywordSearchResults: "request",
  KeywordRequest: "request",
  KeywordSearchResultTrend: "request",
  CategoryRequestKeyword: "request",
  ASINRequestKeyword: "request",
  KeywordProductRanking: "request",
  ASINKeywordRanking: "request",
  KeywordExtends: "request",
  FavoriteKeyword: "request",
  ChangeFavoriteKeyword: "request",
  GetFavoriteKeyword: "unknown",
  // Data monitoring
  KeywordBatchSubscription: "recurring_coin",
  KeywordTasks: "free",
  KeywordBatchTaskUpdate: "recurring_coin",
  // Update=2 can resume Coin-billed monitoring
  KeywordBatchScheduleList: "free",
  KeywordBatchScheduleDetail: "free",
  BestSellerListSubscription: "recurring_coin",
  BestSellerListTask: "free",
  BestSellerListDelete: "free",
  BestSellerListDataCollect: "free",
  ProductSellerSubscription: "recurring_coin",
  ProductSellerTasks: "free",
  ProductSellerTaskUpdate: "recurring_coin",
  // undocumented body; fail closed on worst effect
  ProductSellerTaskScheduleList: "free",
  ProductSellerTaskScheduleDetail: "free",
  ASINSubscription: "recurring_coin",
  ASINSubscriptionQuery: "free",
  ASINSubscriptionCollection: "free",
  // Sorftime Agent
  ProductAssistant: "request",
  CategoryAssistant: "request",
  AIResultQuery: "request",
  AIResult: "free",
  // Account
  CoinQuery: "free",
  CoinStream: "free",
  RequestStreamMonth: "free"
};
var ENDPOINT_EFFECT = {
  // Category market
  CategoryTree: "read",
  CategoryRequest: "read",
  CategoryProducts: "read",
  CategoryTrend: "read",
  // Product
  ProductRequest: "read",
  ProductQuery: "read",
  AsinSalesVolume: "read",
  ProductVariationHistory: "read",
  ProductRealtimeRequest: "read",
  ProductRealtimeRequestStatusQuery: "read",
  ProductReviewsCollection: "read",
  ProductReviewsCollectionStatusQuery: "read",
  ProductReviewsQuery: "read",
  SimilarProductRealtimeRequest: "read",
  SimilarProductRealtimeRequestStatusQuery: "read",
  SimilarProductRealtimeRequestCollection: "read",
  // Keywords
  KeywordQuery: "read",
  KeywordSearchResults: "read",
  KeywordRequest: "read",
  KeywordSearchResultTrend: "read",
  CategoryRequestKeyword: "read",
  ASINRequestKeyword: "read",
  KeywordProductRanking: "read",
  ASINKeywordRanking: "read",
  KeywordExtends: "read",
  FavoriteKeyword: "write",
  ChangeFavoriteKeyword: "write",
  GetFavoriteKeyword: "read",
  // Data monitoring
  KeywordBatchSubscription: "write",
  KeywordTasks: "read",
  KeywordBatchTaskUpdate: "write",
  KeywordBatchScheduleList: "read",
  KeywordBatchScheduleDetail: "read",
  BestSellerListSubscription: "write",
  BestSellerListTask: "read",
  BestSellerListDelete: "write",
  BestSellerListDataCollect: "read",
  ProductSellerSubscription: "write",
  ProductSellerTasks: "read",
  ProductSellerTaskUpdate: "write",
  ProductSellerTaskScheduleList: "read",
  ProductSellerTaskScheduleDetail: "read",
  ASINSubscription: "write",
  ASINSubscriptionQuery: "read",
  ASINSubscriptionCollection: "read",
  // Sorftime Agent
  ProductAssistant: "read",
  CategoryAssistant: "read",
  AIResultQuery: "read",
  AIResult: "read",
  // Account
  CoinQuery: "read",
  CoinStream: "read",
  RequestStreamMonth: "read"
};
function effectFor(endpoint) {
  const effect = ENDPOINT_EFFECT[endpoint];
  if (!effect) throw new ValidationError(`Endpoint '${endpoint}' has no effect classification.`);
  return effect;
}
function validateBillingCatalog() {
  const endpointNames = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
  const billingNames = new Set(Object.keys(ENDPOINT_BILLING));
  const missing = [...endpointNames].filter((name) => !billingNames.has(name));
  const extra = [...billingNames].filter((name) => !endpointNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(
      `Endpoint billing catalog mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`
    );
  }
}
function validateEffectCatalog() {
  const endpointNames = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
  const effectNames = new Set(Object.keys(ENDPOINT_EFFECT));
  const missing = [...endpointNames].filter((name) => !effectNames.has(name));
  const extra = [...effectNames].filter((name) => !endpointNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(
      `Endpoint effect catalog mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`
    );
  }
}
function billingFor(endpoint) {
  const billing = ENDPOINT_BILLING[endpoint];
  if (!billing) throw new ValidationError(`Endpoint '${endpoint}' has no billing classification.`);
  return billing;
}
function spendsCoin(billing) {
  return billing === "coin" || billing === "recurring_coin" || billing === "unknown";
}
function blockedReasons(endpointName, overrides = {}) {
  const billing = ENDPOINT_BILLING[endpointName] ?? "unknown";
  const effect = ENDPOINT_EFFECT[endpointName] ?? "write";
  const reasons = [];
  if (spendsCoin(billing) && overrides.allowCoin !== true) {
    reasons.push({
      kind: "coin",
      detail: billing === "unknown" ? "its upstream cost is undocumented, so it is treated as Coin-spending" : billing === "recurring_coin" ? "it can start or change monitoring that keeps spending Coin every period" : "it spends Coin points"
    });
  }
  if (effect === "write" && overrides.allowWrite !== true) {
    reasons.push({ kind: "write", detail: "it creates, modifies, or deletes state on the shared account" });
  }
  return reasons;
}
function assertEndpointAllowed(endpointName, overrides = {}) {
  const blocked = blockedReasons(endpointName, overrides);
  if (blocked.length === 0) return;
  const flags = blocked.map((reason) => reason.kind === "coin" ? "--allow-coin" : "--allow-write");
  const flagText = flags.length === 1 ? flags[0] : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
  throw new ValidationError(
    `${endpointName} is blocked: ${blocked.map((reason) => reason.detail).join("; ")}. Missing single-call override${flags.length === 1 ? "" : "s"}: ${flagText}.`
  );
}
validateBillingCatalog();
validateEffectCatalog();

// src/output.ts
import { mkdir as mkdir2, rename as rename2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, resolve as resolve2 } from "path";
import YAML from "yaml";
function selectPath(value, path) {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (current === null || current === void 0) return void 0;
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || !(segment in current)) return void 0;
    current = current[segment];
  }
  return current;
}
function rowsFromValue(value) {
  if (Array.isArray(value)) {
    return value.map(
      (item) => item && typeof item === "object" && !Array.isArray(item) ? item : { value: item }
    );
  }
  if (value && typeof value === "object") {
    return [value];
  }
  return [{ value }];
}
function cell(value) {
  if (value === null) return "null";
  if (value === void 0) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function csvCell(value) {
  const text = cell(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(value) {
  const rows = rowsFromValue(value);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return "";
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\n");
}
function truncate(text, width) {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}\u2026`;
}
function toTable(value, maximumRows = 200) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.every(([, item]) => !item || typeof item !== "object")) {
      const keyWidth = Math.min(32, Math.max(3, ...entries.map(([key]) => key.length)));
      return entries.map(([key, item]) => `${key.padEnd(keyWidth)}  ${cell(item)}`).join("\n");
    }
  }
  const allRows = rowsFromValue(value);
  const rows = allRows.slice(0, maximumRows);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return "(empty)";
  const widths = columns.map(
    (column) => Math.min(40, Math.max(column.length, ...rows.map((row) => cell(row[column]).length)))
  );
  const line = (items) => items.map((item, index) => truncate(item, widths[index] ?? 10).padEnd(widths[index] ?? 10)).join("  ");
  const output = [line(columns), line(widths.map((width) => "-".repeat(width))), ...rows.map((row) => line(columns.map((column) => cell(row[column]))))];
  if (allRows.length > maximumRows) output.push(`\u2026 output truncated to ${maximumRows} rows; use --output json or --output-file for full data`);
  return output.join("\n");
}
function toJsonLines(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => JSON.stringify(item)).join("\n");
}
function prepareOutput(value, options) {
  let selected = value;
  if (options.dataOnly) {
    const hasData = Boolean(selected && typeof selected === "object" && !Array.isArray(selected) && Object.keys(selected).some((key) => key.toLowerCase() === "data"));
    if (!hasData) throw new ValidationError("--data-only requires a Data/data field in the response envelope.");
    const data = apiEnvelopeData(selected);
    selected = data;
  }
  if (options.select) {
    const result = selectPath(selected, options.select);
    if (result === void 0) throw new ValidationError(`Selection '${options.select}' did not match the response.`);
    selected = result;
  }
  return selected;
}
function serializeOutput(value, options) {
  switch (options.format) {
    case "json":
      return JSON.stringify(value, null, options.compact ? 0 : 2);
    case "jsonl":
      return toJsonLines(value);
    case "yaml":
      return YAML.stringify(value).trimEnd();
    case "csv":
      return toCsv(value);
    case "table":
      return toTable(value, options.outputFile ? Number.POSITIVE_INFINITY : 200);
    case "raw":
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}
async function writeOutput(value, options) {
  const prepared = prepareOutput(value, options);
  const serialized = serializeOutput(prepared, options);
  const output = options.format === "raw" ? serialized : `${serialized}
`;
  if (!options.outputFile || options.outputFile === "-") {
    process.stdout.write(output);
    return;
  }
  const path = resolve2(options.outputFile);
  await mkdir2(dirname2(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile2(temporary, output);
  await rename2(temporary, path);
}

// src/service.ts
var SorftimeCoreClient = class {
  constructor(config) {
    this.config = config;
  }
  config;
  async call(options) {
    const endpoint = findEndpoint(options.endpoint);
    if (!endpoint || endpoint.name.toLowerCase() !== options.endpoint.toLowerCase()) {
      throw new ValidationError(`Unknown Sorftime endpoint '${options.endpoint}'.`);
    }
    const domain = resolveDomain(options.marketplace);
    return requestApi({
      endpoint: endpoint.name,
      domain: domain.id,
      body: options.body ?? {},
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      timeoutMs: this.config.timeoutMs,
      retries: options.retries ?? this.config.retries ?? 0,
      userAgent: this.config.userAgent,
      ...this.config.maxResponseBytes !== void 0 ? { maxResponseBytes: this.config.maxResponseBytes } : {},
      ...options.signal ? { signal: options.signal } : {},
      ...options.rawResponse !== void 0 ? { rawResponse: options.rawResponse } : {},
      ...options.verbose !== void 0 ? { verbose: options.verbose } : {}
    });
  }
};

// src/runner.ts
var DEFAULT_DEPENDENCIES = {
  loadConfig,
  resolveToken,
  buildRequestBody,
  createCoreClient: (config) => new SorftimeCoreClient(config),
  writeOutput
};
function throwIfAborted2(signal) {
  if (signal?.aborted) throw new NetworkError("Request cancelled.");
}
function integerOption(value, fallback, label, min, max) {
  if (value === void 0 || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}
function outputFormat(value, fallback) {
  const selected = value ?? fallback;
  if (!OUTPUT_FORMATS.includes(selected)) {
    throw new ValidationError(`Output format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }
  return selected;
}
function requestsHistory(endpoint, body) {
  const history = endpoint.history;
  if (!history) return false;
  return history.mode === "always" || history.fields.some((field) => body[field] !== void 0);
}
function caseInsensitiveKey(object, expected) {
  return Object.keys(object).find((key) => key.toLowerCase() === expected.toLowerCase());
}
function locateRows(payload, configuredPath) {
  if (configuredPath.length === 0) {
    return Array.isArray(payload) ? { rows: payload, actualPath: [] } : void 0;
  }
  let current = payload;
  const actualPath = [];
  for (const segment of configuredPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return void 0;
    const actual = caseInsensitiveKey(current, segment);
    if (!actual) return void 0;
    actualPath.push(actual);
    current = current[actual];
  }
  return Array.isArray(current) ? { rows: current, actualPath } : void 0;
}
function hasNullData(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const envelope = payload;
  const dataKey = caseInsensitiveKey(envelope, "Data");
  return dataKey !== void 0 && envelope[dataKey] === null;
}
function replaceRowsAtPath(payload, actualPath, rows) {
  if (actualPath.length === 0) return rows;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return rows;
  const root = { ...payload };
  let source = payload;
  let target = root;
  for (let index = 0; index < actualPath.length; index += 1) {
    const key = actualPath[index];
    if (!key) return rows;
    if (index === actualPath.length - 1) {
      target[key] = rows;
      break;
    }
    const child = source[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) return rows;
    const cloned = { ...child };
    target[key] = cloned;
    source = child;
    target = cloned;
  }
  return root;
}
function aggregatePages(first, location, rows, pagesFetched, startPage, capped) {
  const aggregated = replaceRowsAtPath(first, location.actualPath, rows);
  if (!aggregated || typeof aggregated !== "object" || Array.isArray(aggregated)) return aggregated;
  return {
    ...aggregated,
    _pagination: {
      pagesFetched,
      startPage,
      endPage: startPage + pagesFetched - 1,
      maxPagesReached: capped,
      upstreamMetadataFromPage: startPage
    }
  };
}
async function pageDelay(milliseconds, signal) {
  throwIfAborted2(signal);
  if (milliseconds === 0) return;
  await new Promise((resolve3, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NetworkError("Request cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve3();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function requestAllPages(endpoint, baseBody, requestPage, maxPages, delayMs, signal, verbose) {
  const pagination = endpoint.pagination;
  if (!pagination) throw new ValidationError(`Endpoint ${endpoint.name} does not have a documented safe pagination strategy.`);
  const startPageValue = baseBody[pagination.pageKey];
  const startPage = typeof startPageValue === "number" ? startPageValue : 1;
  let first;
  let firstLocation;
  const allRows = [];
  let pagesFetched = 0;
  let lastPageHadRows = false;
  for (let offset = 0; offset < maxPages; offset += 1) {
    throwIfAborted2(signal);
    const pageNumber = startPage + offset;
    if (offset > 0) await pageDelay(delayMs, signal);
    throwIfAborted2(signal);
    if (verbose) process.stderr.write(`Fetching page ${pageNumber} of ${endpoint.name}
`);
    const payload = await requestPage({ ...baseBody, [pagination.pageKey]: pageNumber });
    throwIfAborted2(signal);
    first ??= payload;
    pagesFetched += 1;
    if (hasNullData(payload)) {
      if (offset === 0) return payload;
      lastPageHadRows = false;
      break;
    }
    const located = locateRows(payload, pagination.rowPath);
    if (!located) {
      throw new ValidationError(
        `Page ${pageNumber} did not contain the registered result array at ${pagination.rowPath.join(".") || "<root>"}.`
      );
    }
    if (firstLocation && firstLocation.actualPath.join(".").toLowerCase() !== located.actualPath.join(".").toLowerCase()) {
      throw new ValidationError(`Result-array shape changed on page ${pageNumber}; pagination stopped without guessing.`);
    }
    firstLocation ??= located;
    allRows.push(...located.rows);
    lastPageHadRows = located.rows.length > 0;
    if (located.rows.length === 0) break;
  }
  if (first === void 0 || firstLocation === void 0) throw new ValidationError("Pagination returned no response.");
  const capped = pagesFetched === maxPages && lastPageHadRows;
  return aggregatePages(first, firstLocation, allRows, pagesFetched, startPage, capped);
}
async function runEndpoint(endpoint, commandOptions, globalOptions2, signal, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  throwIfAborted2(signal);
  assertEndpointAllowed(endpoint.name, { allowCoin: globalOptions2.allowCoin, allowWrite: globalOptions2.allowWrite });
  const config = await dependencies.loadConfig();
  throwIfAborted2(signal);
  const baseUrl = validateCredentialDestination(
    globalOptions2.baseUrl ?? process.env.SORFTIME_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL
  );
  const domain = resolveDomain(globalOptions2.domain ?? process.env.SORFTIME_DOMAIN ?? config.domain);
  const body = await dependencies.buildRequestBody(endpoint, commandOptions, domain.code, signal);
  throwIfAborted2(signal);
  if (!domain.historyBackfill && requestsHistory(endpoint, body) && !globalOptions2.force) {
    throw new ValidationError(
      `${domain.code} does not support historical backfill for this endpoint. Omit historical fields or pass --force to send anyway.`
    );
  }
  const timeoutSeconds = globalOptions2.timeout ?? process.env.SORFTIME_TIMEOUT;
  const timeoutMs = timeoutSeconds === void 0 ? config.timeoutMs ?? endpoint.timeoutMs ?? 6e4 : integerOption(timeoutSeconds, 60, "--timeout", 1, 3600) * 1e3;
  const retries = integerOption(globalOptions2.retries ?? process.env.SORFTIME_RETRIES, 0, "--retries", 0, 5);
  if (retries > 0 && endpoint.unsafeRetry && !globalOptions2.retryUnsafe) {
    throw new ValidationError(
      `${endpoint.name} creates or changes server-side state. Retry is disabled unless --retry-unsafe is explicitly supplied.`
    );
  }
  const defaultOutput = process.stdout.isTTY ? "table" : "json";
  const format = outputFormat(globalOptions2.output ?? process.env.SORFTIME_OUTPUT, config.output ?? defaultOutput);
  const maxPages = integerOption(globalOptions2.maxPages, 100, "--max-pages", 1, 1e3);
  const delayMs = integerOption(globalOptions2.pageDelay, 0, "--page-delay", 0, 6e4);
  if (globalOptions2.allPages && !endpoint.pagination) {
    throw new ValidationError(`Endpoint ${endpoint.name} does not have a documented safe pagination strategy.`);
  }
  if (globalOptions2.allPages && format === "raw") throw new ValidationError("--all-pages cannot be combined with --output raw.");
  throwIfAborted2(signal);
  const tokenResult = await dependencies.resolveToken();
  throwIfAborted2(signal);
  if (!tokenResult.token) {
    throw new AuthenticationError("No Account-SK configured. Run 'sorftime-team auth login' or set SORFTIME_ACCOUNT_SK.");
  }
  const core = dependencies.createCoreClient({
    token: tokenResult.token,
    baseUrl,
    timeoutMs,
    retries,
    userAgent: "sorftime-cli/1.0.0",
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES
  });
  const requestBody = (requestBodyValue) => {
    throwIfAborted2(signal);
    return core.call({
      endpoint: endpoint.name,
      marketplace: domain.id,
      body: requestBodyValue,
      ...signal ? { signal } : {},
      ...globalOptions2.verbose !== void 0 ? { verbose: globalOptions2.verbose } : {},
      ...format === "raw" ? { rawResponse: true } : {}
    });
  };
  const result = globalOptions2.allPages ? await requestAllPages(endpoint, body, requestBody, maxPages, delayMs, signal, globalOptions2.verbose) : await requestBody(body);
  throwIfAborted2(signal);
  await dependencies.writeOutput(result, {
    format,
    ...globalOptions2.dataOnly !== void 0 ? { dataOnly: globalOptions2.dataOnly } : {},
    ...globalOptions2.select !== void 0 ? { select: globalOptions2.select } : {},
    ...globalOptions2.outputFile !== void 0 ? { outputFile: globalOptions2.outputFile } : {},
    ...globalOptions2.compact !== void 0 ? { compact: globalOptions2.compact } : {}
  });
}

// src/cli.ts
var VERSION = "1.0.0";
var rootAbort = new AbortController();
function addBodyOptions(command) {
  command.addOption(new Option("--data <json>", "Raw JSON request body").conflicts(["dataFile", "stdin"])).addOption(new Option("--data-file <path>", "Read the JSON request body from a file").conflicts(["data", "stdin"])).addOption(new Option("--stdin", "Read the JSON request body from standard input").conflicts(["data", "dataFile"]));
}
function optionForParameter(parameter) {
  const flag = `--${optionName(parameter.key)} <value${parameter.type === "string[]" ? "..." : ""}>`;
  const details = [
    parameter.description,
    parameter.required ? "required" : void 0,
    parameter.requiredWhen ? `required on ${parameter.requiredWhen.marketplaces.join(", ")}` : void 0,
    parameter.sourceOptionalButRuntimeRequired ? "runtime-verified requirement" : void 0,
    parameter.choices ? `choices: ${parameter.choices.join(", ")}` : void 0
  ].filter(Boolean).join("; ");
  return new Option(flag, details);
}
function globalOptions(command) {
  return command.optsWithGlobals();
}
function addEndpointCommand(parent, endpoint) {
  const blocked = blockedReasons(endpoint.name);
  const requiredFlags = blocked.map((reason) => reason.kind === "coin" ? "--allow-coin" : "--allow-write");
  const blockedLabel = blocked.length > 0 ? ` [BLOCKED: ${blocked.map((reason) => reason.detail).join("; ")}; needs ${requiredFlags.join(" + ")}]` : "";
  const command = parent.command(endpoint.command).description(`${endpoint.summary} [cost: ${endpoint.cost}]${blockedLabel}`).summary(endpoint.summary);
  for (const parameter of endpoint.parameters) command.addOption(optionForParameter(parameter));
  addBodyOptions(command);
  if (endpoint.undocumentedParameters) {
    command.addHelpText("after", "\nThe source documentation does not define this endpoint's body schema; use --data, --data-file, or --stdin.");
  }
  command.action(async (_options, actionCommand) => {
    await runEndpoint(endpoint, actionCommand.opts(), globalOptions(actionCommand), rootAbort.signal);
  });
}
async function stdinToken() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new ValidationError("Credential input exceeds the 64KB safety limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
function validateConfigValue(key, value) {
  switch (key) {
    case "domain":
      return { domain: resolveDomain(value).code.toLowerCase() };
    case "base-url": {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new ValidationError("Invalid base URL.");
      }
      if (url.protocol !== "https:") throw new ValidationError("Configured base URL must use HTTPS.");
      if (url.username || url.password) throw new ValidationError("Configured base URL must not contain userinfo.");
      if (url.search || url.hash) throw new ValidationError("Configured base URL must not contain a query or fragment.");
      return { baseUrl: value.endsWith("/") ? value : `${value}/` };
    }
    case "timeout": {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new ValidationError("timeout must be 1-3600 seconds.");
      return { timeoutMs: seconds * 1e3 };
    }
    case "output": {
      if (!OUTPUT_FORMATS.includes(value)) throw new ValidationError(`output must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
      return { output: value };
    }
    case "token":
    case "account-sk":
    case "authorization":
      throw new ValidationError("Credentials cannot be stored with config set; use 'sorftime-team auth login'.");
    default:
      throw new ValidationError("Config key must be one of: domain, base-url, timeout, output.");
  }
}
function installAuthCommands(program) {
  const auth = program.command("auth").description("Manage the Sorftime Account-SK credential");
  auth.command("login").description("Store an Account-SK in a mode-0600 local credential file").option("--token-stdin", "Read the credential from standard input (recommended for scripts)").action(async (options) => {
    if (!options.tokenStdin && !process.stdin.isTTY) {
      throw new AuthenticationError("Non-interactive login requires --token-stdin.");
    }
    const token = options.tokenStdin ? await stdinToken() : await password({ message: "Account-SK:" });
    await saveToken(token);
    process.stdout.write("Credential saved to a mode-0600 credential file.\n");
  });
  auth.command("status").description("Show whether a credential is available without revealing it").action(async () => {
    const result = await resolveToken();
    process.stdout.write(result.token ? `Authenticated (source: ${result.source}).
` : "Not authenticated.\n");
    if (!result.token) process.exitCode = 3;
  });
  auth.command("logout").description("Remove the locally stored credential").action(async () => {
    const deleted = await deleteToken();
    process.stdout.write(deleted ? "Stored credential removed.\n" : "No stored credential found.\n");
  });
}
function installConfigCommands(program) {
  const config = program.command("config").description("Manage non-secret CLI defaults");
  config.command("list").description("Print all configured defaults").action(async () => {
    process.stdout.write(`${JSON.stringify(await loadConfig(), null, 2)}
`);
  });
  config.command("path").description("Print the user configuration path").action(() => {
    process.stdout.write(`${configPath()}
`);
  });
  config.command("get <key>").description("Print one configured value").action(async (key) => {
    const current = await loadConfig();
    const patch = validateConfigValue(key, key === "base-url" ? DEFAULT_BASE_URL : key === "domain" ? "us" : key === "timeout" ? "60" : "json");
    const property = Object.keys(patch)[0];
    const value = current[property];
    if (value === void 0) throw new ValidationError(`Config key '${key}' is not set.`);
    process.stdout.write(`${String(property === "timeoutMs" ? Number(value) / 1e3 : value)}
`);
  });
  config.command("set <key> <value>").description("Set a non-secret default").action(async (key, value) => {
    const current = await loadConfig();
    await saveConfig({ ...current, ...validateConfigValue(key, value) });
    process.stdout.write(`Updated ${key}.
`);
  });
  config.command("unset <key>").description("Remove a configured default").action(async (key) => {
    const current = await loadConfig();
    const patch = validateConfigValue(key, key === "base-url" ? DEFAULT_BASE_URL : key === "domain" ? "us" : key === "timeout" ? "60" : "json");
    const property = Object.keys(patch)[0];
    delete current[property];
    await saveConfig(current);
    process.stdout.write(`Removed ${key}.
`);
  });
}
function installUtilityCommands(program) {
  program.command("domains").description("List supported Amazon marketplace domains").action(() => {
    const rows = DOMAINS.map((domain) => ({
      id: domain.id,
      code: domain.code,
      marketplace: domain.name,
      historyBackfill: domain.historyBackfill ? "yes" : "no"
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}
`);
  });
  program.command("endpoints").description("List all implemented Sorftime API endpoints").option("--group <group>", "Filter by command group").option("--json", "Emit JSON").action((options) => {
    const endpoints = options.group ? ENDPOINTS.filter((item) => item.group === options.group) : ENDPOINTS;
    if (options.group && endpoints.length === 0) throw new ValidationError(`Unknown endpoint group '${options.group}'.`);
    if (options.json) {
      const rows = endpoints.map((item) => ({
        ...item,
        billing: billingFor(item.name),
        effect: effectFor(item.name),
        blocked: blockedReasons(item.name).map((reason) => reason.kind)
      }));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}
`);
    } else {
      const lines = endpoints.map((item) => {
        const status = blockedReasons(item.name).map((reason) => reason.kind.toUpperCase()).join("+") || "open";
        return `${item.name.padEnd(45)} ${item.group.padEnd(9)} ${item.command.padEnd(22)} ${billingFor(item.name).padEnd(15)} ${status.padEnd(10)} ${item.cost}`;
      });
      const open = endpoints.filter((item) => blockedReasons(item.name).length === 0).length;
      process.stdout.write(
        `ENDPOINT                                      GROUP     COMMAND                BILLING         STATUS      COST
${lines.join("\n")}

${open}/${endpoints.length} open. COIN and WRITE are independent; COIN+WRITE requires both single-call overrides. COIN = spends Coin, can start recurring Coin use, or has undocumented cost. WRITE = changes shared account state.
`
      );
    }
  });
  const api = program.command("api").description("Low-level API access");
  const call = api.command("call <endpoint>").description("Call an endpoint with a raw JSON body");
  addBodyOptions(call);
  call.action(async (endpointName, _options, actionCommand) => {
    await runEndpoint(resolveApiCallEndpoint(endpointName), actionCommand.opts(), globalOptions(actionCommand), rootAbort.signal);
  });
}
function resolveApiCallEndpoint(endpointName) {
  const known = findEndpoint(endpointName);
  if (known) return known;
  const commandMatches = ENDPOINTS.filter((endpoint) => endpoint.command.toLowerCase() === endpointName.toLowerCase());
  if (commandMatches.length > 1) {
    throw new ValidationError(`Ambiguous command name '${endpointName}'. Use the exact API endpoint name instead.`);
  }
  throw new ValidationError(`Unknown Sorftime endpoint '${endpointName}'. Run 'sorftime-team endpoints' to list registered endpoints.`);
}
function createProgram() {
  const program = new Command();
  program.name("sorftime-team").description("Complete CLI for the Sorftime Enterprise API").version(VERSION).showSuggestionAfterError().showHelpAfterError().option("-d, --domain <domain>", "Amazon marketplace ID/code (default: us)").option("--base-url <url>", "API base URL (remote origins also require deployment trust)").option("--timeout <seconds>", "Request timeout in seconds (1-3600)").option("--retries <count>", "Retry transient transport/HTTP failures (0-5; default: 0)").option("--retry-unsafe", "Allow requested retries for task-creating or mutating endpoints").option("--all-pages", "Fetch and aggregate every page for supported list endpoints").option("--max-pages <count>", "Safety cap for --all-pages (1-1000; default: 100)").option("--page-delay <milliseconds>", "Delay between pages (0-60000; default: 0)").addOption(new Option("-o, --output <format>", "Output format").choices([...OUTPUT_FORMATS])).option("--data-only", "Output only the Data/data field from the response envelope").option("--select <path>", "Select a dot-separated response path").option("--output-file <path>", "Write output atomically to a file").option("--compact", "Emit compact JSON").option("--verbose", "Print safe request diagnostics to stderr (credentials are never printed)").option("--force", "Bypass marketplace history-support guardrails").option("--allow-coin", "Permit one call to a Coin-spending endpoint (blocked by default)").option("--allow-write", "Permit one call that changes shared account state (blocked by default)");
  installAuthCommands(program);
  installConfigCommands(program);
  installUtilityCommands(program);
  for (const groupName of ["category", "product", "keyword", "monitor", "agent", "account"]) {
    const group = program.command(groupName).description(`${groupName[0]?.toUpperCase()}${groupName.slice(1)} API commands`);
    for (const endpoint of ENDPOINTS.filter((item) => item.group === groupName)) addEndpointCommand(group, endpoint);
  }
  return program;
}
function safeError(error) {
  if (error instanceof CommanderError) return { message: error.message, exitCode: error.exitCode };
  if (error instanceof CliError) return { message: error.message, exitCode: error.exitCode };
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}
async function runCli(argv = process.argv) {
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (rootAbort.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    const safe = safeError(error);
    process.stderr.write(`Error: ${safe.message}
`);
    process.exitCode = safe.exitCode;
  }
}
process.once("SIGINT", () => {
  rootAbort.abort(new Error("Interrupted"));
  process.exitCode = 130;
});
var invokedPath = process.argv[1];
var isEntrypoint = invokedPath !== void 0 && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
if (isEntrypoint) await runCli();
export {
  createProgram,
  resolveApiCallEndpoint,
  runCli
};
