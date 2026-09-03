import { requestApi } from "./client.js";
import { resolveDomain } from "./domains.js";
import { findEndpoint } from "./endpoints.js";
import { ValidationError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface SorftimeCoreConfig {
  token: string;
  baseUrl: string;
  timeoutMs: number;
  retries?: number;
  userAgent: string;
  maxResponseBytes?: number;
}

export interface SorftimeCallOptions {
  endpoint: string;
  marketplace: string | number;
  body?: JsonObject;
  signal?: AbortSignal;
  retries?: number;
  rawResponse?: boolean;
  verbose?: boolean;
}

/** Deterministic API execution core. Endpoint resolution and transport live here; policy does not. */
export class SorftimeCoreClient {
  constructor(private readonly config: SorftimeCoreConfig) {}

  async call(options: SorftimeCallOptions): Promise<JsonValue> {
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
      ...(this.config.maxResponseBytes !== undefined ? { maxResponseBytes: this.config.maxResponseBytes } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.rawResponse !== undefined ? { rawResponse: options.rawResponse } : {}),
      ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    });
  }
}
