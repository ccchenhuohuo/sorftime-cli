import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { stdin } from "node:process";
import { ValidationError } from "./errors.js";
import type { EndpointSpec, JsonObject, JsonValue, ParameterSpec } from "./types.js";

const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function optionName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

export function commanderProperty(key: string): string {
  const name = optionName(key);
  return name.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Interrupted");
}

async function readLimitedFile(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  throwIfAborted(signal);
  if (metadata.size > MAX_JSON_BYTES) {
    throw new ValidationError(`Input file exceeds the ${MAX_JSON_BYTES / 1024 / 1024}MB limit.`);
  }
  const buffer = await readFile(absolute, signal ? { signal } : undefined);
  throwIfAborted(signal);
  return buffer.toString("utf8");
}

async function readStdin(signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolveInput, rejectInput) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer | string): void => {
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
    const onEnd = (): void => {
      cleanup();
      resolveInput(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectInput(error);
    };
    const onAbort = (): void => {
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

function parseJsonObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Parser messages are runtime-dependent and may quote the input around the
    // failure. Do not risk echoing a secret that was accidentally pasted here.
    throw new ValidationError(`Invalid JSON in ${label}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must contain a JSON object.`);
  }
  return value as JsonObject;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateFormat(value: string, parameter: ParameterSpec): void {
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

function parseNumber(value: unknown, integer: boolean, parameter: ParameterSpec): number {
  if (typeof value === "number") {
    if (integer && !Number.isInteger(value)) throw new ValidationError(`${parameter.key} must be an integer.`);
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${parameter.key} must be a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new ValidationError(`${parameter.key} must be ${integer ? "an integer" : "a number"}.`);
  }
  return parsed;
}

function mimeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

async function coerceValue(raw: unknown, parameter: ParameterSpec, signal?: AbortSignal): Promise<JsonValue> {
  throwIfAborted(signal);
  if (parameter.type === "integer" || parameter.type === "number") {
    const value = parseNumber(raw, parameter.type === "integer", parameter);
    if (parameter.min !== undefined && value < parameter.min) {
      throw new ValidationError(`${parameter.key} must be at least ${parameter.min}.`);
    }
    if (parameter.max !== undefined && value > parameter.max) {
      throw new ValidationError(`${parameter.key} must be at most ${parameter.max}.`);
    }
    if (parameter.choices && !parameter.choices.includes(value)) {
      throw new ValidationError(`${parameter.key} must be one of: ${parameter.choices.join(", ")}.`);
    }
    return value;
  }
  if (parameter.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const value = String(raw).toLowerCase();
    if (["true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    throw new ValidationError(`${parameter.key} must be true or false.`);
  }
  if (parameter.type === "string[]") {
    const values = Array.isArray(raw) ? raw : [raw];
    const items = values.flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
    for (const item of items) validateFormat(item, parameter);
    return parameter.wire === "csv" ? items.join(",") : items;
  }
  if (parameter.type === "json") {
    if (typeof raw !== "string") return raw as JsonValue;
    const text = raw.startsWith("@") ? await readLimitedFile(raw.slice(1), signal) : raw;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new ValidationError(`Invalid JSON for ${parameter.key}.`);
    }
  }
  if (parameter.type === "image") {
    const value = String(raw);
    if (!value.startsWith("@")) return value;
    const path = value.slice(1);
    const absolute = resolve(path);
    const metadata = await stat(absolute);
    throwIfAborted(signal);
    if (metadata.size > MAX_IMAGE_BYTES) {
      throw new ValidationError(`Image file exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB safety limit.`);
    }
    const buffer = await readFile(absolute, signal ? { signal } : undefined);
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

export interface BodyInputOptions {
  data?: string;
  dataFile?: string;
  stdin?: boolean;
}

export async function buildRequestBody(
  endpoint: EndpointSpec,
  commandOptions: Record<string, unknown>,
  marketplace?: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  throwIfAborted(signal);
  const input: BodyInputOptions = {
    ...(typeof commandOptions.data === "string" ? { data: commandOptions.data } : {}),
    ...(typeof commandOptions.dataFile === "string" ? { dataFile: commandOptions.dataFile } : {}),
    ...(commandOptions.stdin === true ? { stdin: true } : {}),
  };
  const rawModes = [input.data !== undefined, input.dataFile !== undefined, input.stdin].filter(Boolean).length;
  if (rawModes > 1) throw new ValidationError("Use only one of --data, --data-file, or --stdin.");

  let body: JsonObject = {};
  if (input.data !== undefined) body = parseJsonObject(input.data, "--data");
  if (input.dataFile !== undefined) body = parseJsonObject(await readLimitedFile(input.dataFile, signal), input.dataFile);
  if (input.stdin) body = parseJsonObject(await readStdin(signal), "standard input");

  for (const parameter of endpoint.parameters) {
    const raw = commandOptions[commanderProperty(parameter.key)];
    if (raw !== undefined) body[parameter.key] = await coerceValue(raw, parameter, signal);
  }

  for (const parameter of endpoint.parameters) {
    const required = parameter.required === true
      || (parameter.requiredWhen?.marketplaces.includes((marketplace ?? "US").toUpperCase()) ?? false);
    const initialValue = body[parameter.key];
    if (required && isEmptyRequiredValue(initialValue)) {
      const reason = parameter.requiredWhen ? ` ${parameter.requiredWhen.reason}.` : "";
      throw new ValidationError(
        `Missing required option --${optionName(parameter.key)} (or provide ${parameter.key} in raw JSON).${reason}`,
      );
    }
    if (initialValue === null) throw new ValidationError(`${parameter.key} cannot be null.`);
    if (initialValue !== undefined) body[parameter.key] = await coerceValue(initialValue, parameter, signal);
    if (required && isEmptyRequiredValue(body[parameter.key])) {
      const reason = parameter.requiredWhen ? ` ${parameter.requiredWhen.reason}.` : "";
      throw new ValidationError(
        `Missing required option --${optionName(parameter.key)} (or provide ${parameter.key} in raw JSON).${reason}`,
      );
    }
  }

  validateEndpointBody(endpoint, body);
  throwIfAborted(signal);
  return body;
}

function isEmptyRequiredValue(value: JsonValue | undefined): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && value.trim() === "")
    || (Array.isArray(value) && value.length === 0);
}

function dateOrdinal(value: JsonValue | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = /^\d{4}-\d{2}$/u.test(value) ? `${value}-01` : value;
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function validateDateRanges(endpoint: EndpointSpec, body: JsonObject): void {
  for (const range of endpoint.dateRanges ?? []) {
    const start = dateOrdinal(body[range.startKey]);
    const end = dateOrdinal(body[range.endKey]);
    if (start === undefined || end === undefined) continue;
    if (start > end) {
      throw new ValidationError(`${range.startKey} must not be after ${range.endKey}.`);
    }
    if (range.maxCalendarDays !== undefined) {
      const calendarDays = Math.floor((end - start) / 86_400_000) + 1;
      if (calendarDays > range.maxCalendarDays) {
        throw new ValidationError(
          `${range.startKey} through ${range.endKey} may span at most ${range.maxCalendarDays} calendar days.`,
        );
      }
    }
  }
}

function validateEndpointBody(endpoint: EndpointSpec, body: JsonObject): void {
  validateDateRanges(endpoint, body);
  // ASIN goes on the wire as a comma-separated string, so count the parts, not an array.
  if (endpoint.name === "ProductRequest" && body.ASIN !== undefined) {
    const count = Array.isArray(body.ASIN)
      ? body.ASIN.length
      : String(body.ASIN).split(",").filter((part) => part.trim().length > 0).length;
    if (count > 10) throw new ValidationError("ProductRequest accepts at most 10 ASINs per call.");
  }
  if (endpoint.name === "ProductQuery" && (body.Query === undefined || body.Query === 1)) {
    if (body.QueryType === undefined || body.Pattern === undefined) {
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
    if (start !== undefined && end !== undefined && start > end) {
      throw new ValidationError("CoinStream QueryDate start must not be after end.");
    }
  }
  if (endpoint.name === "ProductRequest" && body.QueryTrendEndDt !== undefined && body.QueryTrendStartDt === undefined) {
    throw new ValidationError("--query-trend-end-dt requires --query-trend-start-dt.");
  }
}
