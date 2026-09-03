import { ApiError, NetworkError, ValidationError } from "./errors.js";
import type { ApiRequestOptions, JsonObject, JsonValue } from "./types.js";

export const DEFAULT_BASE_URL = "https://standardapi.sorftime.com/api/";
export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
export const TRUSTED_ORIGINS_ENV = "SORFTIME_TRUSTED_ORIGINS";

const CANONICAL_ORIGIN = new URL(DEFAULT_BASE_URL).origin;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const API_MESSAGES: Record<number, string> = {
  4: "Insufficient coin balance",
  9: "Resource access is restricted",
  10: "Invalid request parameters",
  400: "Request originated from an unauthorized IP address",
  401: "This API endpoint is not enabled for the account",
  402: "The account is not authorized to view this data",
  500: "Monthly request quota has been exhausted",
  501: "Per-minute request quota has been reached",
  694: "Insufficient request balance",
};

function normalizeBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.endsWith("/") ? input : `${input}/`);
  } catch {
    throw new ValidationError("Invalid base URL.");
  }
  if (!(["https:", "http:"] as string[]).includes(url.protocol)) {
    throw new ValidationError("Base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ValidationError("Base URL userinfo is forbidden; credentials must not appear in a URL.");
  }
  if (url.search || url.hash) throw new ValidationError("Base URL must not contain a query or fragment.");
  return url;
}

function deploymentTrustedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of raw?.split(",") ?? []) {
    const value = entry.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError(`${TRUSTED_ORIGINS_ENV} must be a comma-separated list of HTTPS origins.`);
    }
    if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new ValidationError(`${TRUSTED_ORIGINS_ENV} must contain HTTPS origins only (no path, query, fragment, or userinfo).`);
    }
    origins.add(url.origin);
  }
  return origins;
}

/**
 * Bind Account-SK use to the canonical service, loopback tests, or a deployment-level
 * exact-origin allowlist. The allowlist is intentionally not a normal CLI flag.
 */
export function validateCredentialDestination(
  input: string,
  trustedOrigins = process.env[TRUSTED_ORIGINS_ENV],
): string {
  const url = normalizeBaseUrl(input);
  const local = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ValidationError("Base URL must use HTTPS (HTTP is accepted only for localhost testing).");
  }
  const trusted = url.origin === CANONICAL_ORIGIN || local || deploymentTrustedOrigins(trustedOrigins).has(url.origin);
  if (!trusted) {
    throw new ValidationError(
      `Refusing to send the Account-SK to untrusted origin '${url.origin}'. `
      + `A deployment administrator must add the exact origin to ${TRUSTED_ORIGINS_ENV}.`,
    );
  }
  return url.toString();
}

function endpointUrl(baseUrl: string, endpoint: string, domain: number): URL {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(endpoint)) {
    throw new ValidationError(`Invalid API endpoint '${endpoint}'.`);
  }
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  url.searchParams.set("domain", String(domain));
  return url;
}

function getCaseInsensitive(object: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : object[found];
}

export function apiEnvelopeCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = getCaseInsensitive(value as Record<string, unknown>, "code");
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/u.test(raw)) return Number(raw);
  return undefined;
}

export function apiEnvelopeData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return getCaseInsensitive(value as Record<string, unknown>, "data");
}

function apiEnvelopeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = getCaseInsensitive(value as Record<string, unknown>, "message");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

const SECRET_LOG_KEY = /(authorization|credential|api[-_]?key|token|secret|password|account[-_]?sk)/iu;

function redactLogValue(value: JsonValue, token: string, key?: string): JsonValue {
  if (key && SECRET_LOG_KEY.test(key)) return "[redacted secret]";
  if (key?.toLowerCase() === "image" && typeof value === "string") {
    return `[image data: ${value.length} characters]`;
  }
  if (typeof value === "string" && token && value.includes(token)) return "[redacted credential]";
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactLogValue(child, token, childKey)]),
    );
  }
  return value;
}

function redactForLog(body: JsonObject, token: string): JsonObject {
  return redactLogValue(body, token) as JsonObject;
}

function redactText(value: string, token: string): string {
  return token ? value.replaceAll(token, "[redacted credential]") : value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 30_000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 30_000));
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new NetworkError("Request cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NetworkError("Request cancelled.");
}

async function readResponseText(response: Response, maximumBytes?: number): Promise<string> {
  if (maximumBytes === undefined) return response.text();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new NetworkError(`Sorftime API response exceeds the ${maximumBytes}-byte safety limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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

async function parseResponse(response: Response, maximumBytes?: number): Promise<{ value: JsonValue; raw: string; validJson: boolean }> {
  const text = await readResponseText(response, maximumBytes);
  if (!text) return { value: null, raw: text, validJson: true };
  try {
    return { value: JSON.parse(text) as JsonValue, raw: text, validJson: true };
  } catch {
    return { value: response.ok ? text : { raw: text }, raw: text, validJson: false };
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const forwardAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

export async function requestApi(
  options: ApiRequestOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<JsonValue> {
  throwIfCancelled(options.signal);
  const baseUrl = validateCredentialDestination(options.baseUrl);
  const url = endpointUrl(baseUrl, options.endpoint, options.domain);
  const maxAttempts = options.retries + 1;

  if (options.verbose) {
    process.stderr.write(`POST ${url.toString()}\n${JSON.stringify(redactForLog(options.body, options.token))}\n`);
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
          "User-Agent": options.userAgent ?? "sorftime-cli/1.0.0",
        },
        body: JSON.stringify(options.body),
        signal: timed.signal,
        redirect: "error",
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
          payload,
        );
      }

      if (!parsed.validJson && !options.rawResponse) {
        throw new NetworkError("Sorftime API returned a non-JSON success response.");
      }

      const code = apiEnvelopeCode(payload);
      if (code !== undefined && code !== 0) {
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
      const message = timed.signal.aborted && !options.signal?.aborted
        ? `Request timed out after ${options.timeoutMs}ms.`
        : options.signal?.aborted
          ? "Request cancelled."
          : `Unable to reach Sorftime API: ${redactText(error instanceof Error ? error.message : String(error), options.token)}`;
      throw new NetworkError(message);
    } finally {
      timed.cleanup();
    }
  }
  throw new NetworkError("Sorftime API request failed.");
}
