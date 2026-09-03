import { DEFAULT_BASE_URL, DEFAULT_MAX_RESPONSE_BYTES, validateCredentialDestination } from "./client.js";
import { loadConfig, resolveToken } from "./config.js";
import { resolveDomain } from "./domains.js";
import { AuthenticationError, NetworkError, ValidationError } from "./errors.js";
import { buildRequestBody } from "./input.js";
import { writeOutput } from "./output.js";
import { assertEndpointAllowed } from "./policy.js";
import { SorftimeCoreClient } from "./service.js";
import { OUTPUT_FORMATS } from "./types.js";
import type { SorftimeCallOptions, SorftimeCoreConfig } from "./service.js";
import type { EndpointSpec, GlobalOptions, JsonObject, JsonValue, OutputFormat } from "./types.js";

interface CoreClientLike {
  call(options: SorftimeCallOptions): Promise<JsonValue>;
}

interface RunnerDependencies {
  loadConfig: typeof loadConfig;
  resolveToken: typeof resolveToken;
  buildRequestBody: typeof buildRequestBody;
  createCoreClient: (config: SorftimeCoreConfig) => CoreClientLike;
  writeOutput: typeof writeOutput;
}

const DEFAULT_DEPENDENCIES: RunnerDependencies = {
  loadConfig,
  resolveToken,
  buildRequestBody,
  createCoreClient: (config) => new SorftimeCoreClient(config),
  writeOutput,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NetworkError("Request cancelled.");
}

function integerOption(value: string | number | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function outputFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
  const selected = value ?? fallback;
  if (!OUTPUT_FORMATS.includes(selected as OutputFormat)) {
    throw new ValidationError(`Output format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }
  return selected as OutputFormat;
}

function requestsHistory(endpoint: EndpointSpec, body: JsonObject): boolean {
  const history = endpoint.history;
  if (!history) return false;
  return history.mode === "always" || history.fields.some((field) => body[field] !== undefined);
}

interface RowLocation {
  rows: JsonValue[];
  actualPath: string[];
}

function caseInsensitiveKey(object: Record<string, JsonValue>, expected: string): string | undefined {
  return Object.keys(object).find((key) => key.toLowerCase() === expected.toLowerCase());
}

function locateRows(payload: JsonValue, configuredPath: readonly string[]): RowLocation | undefined {
  if (configuredPath.length === 0) {
    return Array.isArray(payload) ? { rows: payload, actualPath: [] } : undefined;
  }
  let current: JsonValue = payload;
  const actualPath: string[] = [];
  for (const segment of configuredPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const actual = caseInsensitiveKey(current as Record<string, JsonValue>, segment);
    if (!actual) return undefined;
    actualPath.push(actual);
    current = (current as Record<string, JsonValue>)[actual] as JsonValue;
  }
  return Array.isArray(current) ? { rows: current, actualPath } : undefined;
}

function hasNullData(payload: JsonValue): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const envelope = payload as Record<string, JsonValue>;
  const dataKey = caseInsensitiveKey(envelope, "Data");
  return dataKey !== undefined && envelope[dataKey] === null;
}

function replaceRowsAtPath(payload: JsonValue, actualPath: readonly string[], rows: JsonValue[]): JsonValue {
  if (actualPath.length === 0) return rows;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return rows;
  const root = { ...(payload as Record<string, JsonValue>) };
  let source: Record<string, JsonValue> = payload as Record<string, JsonValue>;
  let target: Record<string, JsonValue> = root;
  for (let index = 0; index < actualPath.length; index += 1) {
    const key = actualPath[index];
    if (!key) return rows;
    if (index === actualPath.length - 1) {
      target[key] = rows;
      break;
    }
    const child = source[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) return rows;
    const cloned = { ...(child as Record<string, JsonValue>) };
    target[key] = cloned;
    source = child as Record<string, JsonValue>;
    target = cloned;
  }
  return root;
}

function aggregatePages(
  first: JsonValue,
  location: RowLocation,
  rows: JsonValue[],
  pagesFetched: number,
  startPage: number,
  capped: boolean,
): JsonValue {
  const aggregated = replaceRowsAtPath(first, location.actualPath, rows);
  if (!aggregated || typeof aggregated !== "object" || Array.isArray(aggregated)) return aggregated;
  return {
    ...(aggregated as Record<string, JsonValue>),
    _pagination: {
      pagesFetched,
      startPage,
      endPage: startPage + pagesFetched - 1,
      maxPagesReached: capped,
      upstreamMetadataFromPage: startPage,
    },
  };
}

async function pageDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new NetworkError("Request cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestAllPages(
  endpoint: EndpointSpec,
  baseBody: JsonObject,
  requestPage: (body: JsonObject) => Promise<JsonValue>,
  maxPages: number,
  delayMs: number,
  signal?: AbortSignal,
  verbose?: boolean,
): Promise<JsonValue> {
  const pagination = endpoint.pagination;
  if (!pagination) throw new ValidationError(`Endpoint ${endpoint.name} does not have a documented safe pagination strategy.`);
  const startPageValue = baseBody[pagination.pageKey];
  const startPage = typeof startPageValue === "number" ? startPageValue : 1;

  let first: JsonValue | undefined;
  let firstLocation: RowLocation | undefined;
  const allRows: JsonValue[] = [];
  let pagesFetched = 0;
  let lastPageHadRows = false;

  for (let offset = 0; offset < maxPages; offset += 1) {
    throwIfAborted(signal);
    const pageNumber = startPage + offset;
    if (offset > 0) await pageDelay(delayMs, signal);
    throwIfAborted(signal);
    if (verbose) process.stderr.write(`Fetching page ${pageNumber} of ${endpoint.name}\n`);
    const payload = await requestPage({ ...baseBody, [pagination.pageKey]: pageNumber });
    throwIfAborted(signal);
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
        `Page ${pageNumber} did not contain the registered result array at ${pagination.rowPath.join(".") || "<root>"}.`,
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

  if (first === undefined || firstLocation === undefined) throw new ValidationError("Pagination returned no response.");
  const capped = pagesFetched === maxPages && lastPageHadRows;
  return aggregatePages(first, firstLocation, allRows, pagesFetched, startPage, capped);
}

export async function runEndpoint(
  endpoint: EndpointSpec,
  commandOptions: Record<string, unknown>,
  globalOptions: GlobalOptions,
  signal?: AbortSignal,
  dependencyOverrides: Partial<RunnerDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  throwIfAborted(signal);
  assertEndpointAllowed(endpoint.name, { allowCoin: globalOptions.allowCoin, allowWrite: globalOptions.allowWrite });

  const config = await dependencies.loadConfig();
  throwIfAborted(signal);
  const baseUrl = validateCredentialDestination(
    globalOptions.baseUrl ?? process.env.SORFTIME_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL,
  );
  const domain = resolveDomain(globalOptions.domain ?? process.env.SORFTIME_DOMAIN ?? config.domain);
  const body = await dependencies.buildRequestBody(endpoint, commandOptions, domain.code, signal);
  throwIfAborted(signal);
  if (!domain.historyBackfill && requestsHistory(endpoint, body) && !globalOptions.force) {
    throw new ValidationError(
      `${domain.code} does not support historical backfill for this endpoint. Omit historical fields or pass --force to send anyway.`,
    );
  }

  const timeoutSeconds = globalOptions.timeout ?? process.env.SORFTIME_TIMEOUT;
  const timeoutMs = timeoutSeconds === undefined
    ? config.timeoutMs ?? endpoint.timeoutMs ?? 60_000
    : integerOption(timeoutSeconds, 60, "--timeout", 1, 3600) * 1000;
  const retries = integerOption(globalOptions.retries ?? process.env.SORFTIME_RETRIES, 0, "--retries", 0, 5);
  if (retries > 0 && endpoint.unsafeRetry && !globalOptions.retryUnsafe) {
    throw new ValidationError(
      `${endpoint.name} creates or changes server-side state. Retry is disabled unless --retry-unsafe is explicitly supplied.`,
    );
  }
  const defaultOutput: OutputFormat = process.stdout.isTTY ? "table" : "json";
  const format = outputFormat(globalOptions.output ?? process.env.SORFTIME_OUTPUT, config.output ?? defaultOutput);
  const maxPages = integerOption(globalOptions.maxPages, 100, "--max-pages", 1, 1000);
  const delayMs = integerOption(globalOptions.pageDelay, 0, "--page-delay", 0, 60_000);
  if (globalOptions.allPages && !endpoint.pagination) {
    throw new ValidationError(`Endpoint ${endpoint.name} does not have a documented safe pagination strategy.`);
  }
  if (globalOptions.allPages && format === "raw") throw new ValidationError("--all-pages cannot be combined with --output raw.");

  throwIfAborted(signal);
  const tokenResult = await dependencies.resolveToken();
  throwIfAborted(signal);
  if (!tokenResult.token) {
    throw new AuthenticationError("No Account-SK configured. Run 'sorftime-team auth login' or set SORFTIME_ACCOUNT_SK.");
  }

  const core = dependencies.createCoreClient({
    token: tokenResult.token,
    baseUrl,
    timeoutMs,
    retries,
    userAgent: "sorftime-cli/1.0.0",
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });
  const requestBody = (requestBodyValue: JsonObject): Promise<JsonValue> => {
    throwIfAborted(signal);
    return core.call({
      endpoint: endpoint.name,
      marketplace: domain.id,
      body: requestBodyValue,
      ...(signal ? { signal } : {}),
      ...(globalOptions.verbose !== undefined ? { verbose: globalOptions.verbose } : {}),
      ...(format === "raw" ? { rawResponse: true } : {}),
    });
  };
  const result = globalOptions.allPages
    ? await requestAllPages(endpoint, body, requestBody, maxPages, delayMs, signal, globalOptions.verbose)
    : await requestBody(body);
  throwIfAborted(signal);
  await dependencies.writeOutput(result, {
    format,
    ...(globalOptions.dataOnly !== undefined ? { dataOnly: globalOptions.dataOnly } : {}),
    ...(globalOptions.select !== undefined ? { select: globalOptions.select } : {}),
    ...(globalOptions.outputFile !== undefined ? { outputFile: globalOptions.outputFile } : {}),
    ...(globalOptions.compact !== undefined ? { compact: globalOptions.compact } : {}),
  });
}
