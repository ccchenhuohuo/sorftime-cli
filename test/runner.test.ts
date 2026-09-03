import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL } from "../src/client.js";
import { resolveApiCallEndpoint } from "../src/cli.js";
import { findEndpoint } from "../src/endpoints.js";
import { requestAllPages, runEndpoint } from "../src/runner.js";
import type { EndpointSpec, JsonObject, JsonValue } from "../src/types.js";

function endpoint(name: string): EndpointSpec {
  const found = findEndpoint(name);
  if (!found) throw new Error(`Missing fixture endpoint ${name}`);
  return found;
}

function paginationFixture(rowPath: readonly string[]): EndpointSpec {
  return {
    name: "CoinQuery",
    group: "account",
    command: "coins",
    summary: "test",
    cost: "free",
    parameters: [],
    pagination: {
      pageKey: "Page",
      defaultPageSize: 20,
      rowPath,
      termination: "empty-page",
    },
  };
}

describe("safe pagination", () => {
  it("treats first-page Data:null as a zero-row terminal page without rewriting it", async () => {
    const payload = { Code: 0, Data: null, RequestLeft: 10 };
    const request = vi.fn(async () => payload);
    await expect(requestAllPages(paginationFixture(["Data"]), {}, request, 10, 0)).resolves.toBe(payload);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps rows from a full page when the following terminal page has Data:null", async () => {
    const request = vi.fn(async (body: JsonObject): Promise<JsonValue> => body.Page === 1
      ? { Code: 0, Data: [{ id: 1 }] }
      : { Code: 0, Data: null });
    await expect(requestAllPages(paginationFixture(["Data"]), {}, request, 10, 0)).resolves.toMatchObject({
      Data: [{ id: 1 }],
      _pagination: { pagesFetched: 2, maxPagesReached: false },
    });
  });

  it("does not mistake a short non-empty page for proof of termination", async () => {
    const request = vi.fn(async (body: JsonObject): Promise<JsonValue> => {
      if (body.Page === 1) return { Code: 0, Data: [{ id: 1 }] };
      if (body.Page === 2) return { Code: 0, Data: [{ id: 2 }] };
      return { Code: 0, Data: [] };
    });
    const result = await requestAllPages(paginationFixture(["Data"]), {}, request, 10, 0);
    expect(request.mock.calls.map(([body]) => body.Page)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      Data: [{ id: 1 }, { id: 2 }],
      _pagination: { pagesFetched: 3, endPage: 3, maxPagesReached: false, upstreamMetadataFromPage: 1 },
    });
  });

  it("aggregates registered Data.Products and root-array shapes", async () => {
    const productsRequest = vi.fn(async (body: JsonObject): Promise<JsonValue> => body.Page === 1
      ? { Code: 0, Data: { Products: [{ id: 1 }], Total: 1 } }
      : { Code: 0, Data: { Products: [], Total: 1 } });
    await expect(requestAllPages(paginationFixture(["Data", "Products"]), {}, productsRequest, 5, 0))
      .resolves.toMatchObject({ Data: { Products: [{ id: 1 }], Total: 1 } });

    const rootRequest = vi.fn(async (body: JsonObject): Promise<JsonValue> => body.Page === 1 ? [{ id: 1 }] : []);
    await expect(requestAllPages(paginationFixture([]), {}, rootRequest, 5, 0)).resolves.toEqual([{ id: 1 }]);
  });

  it("fails instead of guessing among unregistered arrays or changed page shapes", async () => {
    const ambiguous = vi.fn(async (): Promise<JsonValue> => ({
      Code: 0,
      Data: { Items: [{ id: 1 }], Results: [{ id: 2 }] },
    }));
    await expect(requestAllPages(paginationFixture(["Data", "Products"]), {}, ambiguous, 5, 0))
      .rejects.toThrow(/registered result array at Data.Products/u);

    const drift = vi.fn(async (body: JsonObject): Promise<JsonValue> => body.Page === 1
      ? { Code: 0, Data: [{ id: 1 }] }
      : { Code: 0, Data: { Products: [] } });
    await expect(requestAllPages(paginationFixture(["Data"]), {}, drift, 5, 0))
      .rejects.toThrow(/registered result array at Data/u);
  });

  it("marks a non-empty max-page boundary as capped", async () => {
    const request = vi.fn(async (body: JsonObject): Promise<JsonValue> => ({ Code: 0, Data: [{ id: body.Page ?? null }] }));
    await expect(requestAllPages(paginationFixture(["Data"]), {}, request, 2, 0)).resolves.toMatchObject({
      Data: [{ id: 1 }, { id: 2 }],
      _pagination: { pagesFetched: 2, maxPagesReached: true },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("checks cancellation before the first page and while delaying between pages", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const never = vi.fn(async (): Promise<JsonValue> => []);
    await expect(requestAllPages(paginationFixture([]), {}, never, 5, 0, alreadyAborted.signal))
      .rejects.toThrow("Request cancelled");
    expect(never).not.toHaveBeenCalled();

    const betweenPages = new AbortController();
    const once = vi.fn(async (): Promise<JsonValue> => {
      setTimeout(() => betweenPages.abort(), 0);
      return [{ id: 1 }];
    });
    await expect(requestAllPages(paginationFixture([]), {}, once, 5, 100, betweenPages.signal))
      .rejects.toThrow("Request cancelled");
    expect(once).toHaveBeenCalledTimes(1);
  });
});

describe("runner guard ordering and registry fidelity", () => {
  it("does no work when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const load = vi.fn(async () => ({}));
    const resolveToken = vi.fn(async () => ({ token: "preabort-sentinel", source: "environment" as const }));
    const createCoreClient = vi.fn(() => ({ call: vi.fn(async () => ({ Code: 0 })) }));
    await expect(runEndpoint(endpoint("CoinQuery"), {}, {}, controller.signal, {
      loadConfig: load,
      resolveToken,
      createCoreClient,
    })).rejects.toThrow("Request cancelled");
    expect(load).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(createCoreClient).not.toHaveBeenCalled();
  });

  it("blocks policy before config, credential resolution, or client creation", async () => {
    const load = vi.fn(async () => ({}));
    const resolveToken = vi.fn(async () => ({ token: "must-not-load", source: "environment" as const }));
    const createCoreClient = vi.fn(() => ({ call: vi.fn(async () => ({ Code: 0 })) }));
    await expect(runEndpoint(endpoint("KeywordBatchSubscription"), {}, {}, undefined, {
      loadConfig: load,
      resolveToken,
      createCoreClient,
    })).rejects.toThrow(/--allow-coin and --allow-write/u);
    expect(load).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(createCoreClient).not.toHaveBeenCalled();
  });

  it("rejects an untrusted remote origin before credential resolution or request creation", async () => {
    const resolveToken = vi.fn(async () => ({ token: "destination-sentinel", source: "environment" as const }));
    const createCoreClient = vi.fn(() => ({ call: vi.fn(async () => ({ Code: 0 })) }));
    await expect(runEndpoint(endpoint("CoinQuery"), {}, {
      baseUrl: "https://collector.example/api/",
      output: "json",
    }, undefined, {
      loadConfig: async () => ({}),
      resolveToken,
      createCoreClient,
      writeOutput: async () => undefined,
    })).rejects.toThrow(/untrusted origin/u);
    expect(resolveToken).not.toHaveBeenCalled();
    expect(createCoreClient).not.toHaveBeenCalled();
  });

  it("checks cancellation after asynchronous body construction and never creates a request", async () => {
    const controller = new AbortController();
    const resolveToken = vi.fn(async () => ({ token: "abort-sentinel", source: "environment" as const }));
    const createCoreClient = vi.fn(() => ({ call: vi.fn(async () => ({ Code: 0 })) }));
    await expect(runEndpoint(endpoint("CoinQuery"), {}, {
      baseUrl: DEFAULT_BASE_URL,
      output: "json",
    }, controller.signal, {
      loadConfig: async () => ({}),
      buildRequestBody: async () => {
        controller.abort();
        return {};
      },
      resolveToken,
      createCoreClient,
      writeOutput: async () => undefined,
    })).rejects.toThrow("Request cancelled");
    expect(resolveToken).not.toHaveBeenCalled();
    expect(createCoreClient).not.toHaveBeenCalled();
  });

  it("passes the complete api-call registry spec, including CategoryTree's 900-second timeout", async () => {
    const categoryTree = resolveApiCallEndpoint("CategoryTree");
    expect(categoryTree).toBe(endpoint("CategoryTree"));
    let observedTimeout: number | undefined;
    let observedMaximumBytes: number | undefined;
    await runEndpoint(categoryTree, { data: "{}" }, {
      baseUrl: DEFAULT_BASE_URL,
      output: "json",
    }, undefined, {
      loadConfig: async () => ({}),
      resolveToken: async () => ({ token: "timeout-sentinel", source: "environment" as const }),
      createCoreClient: (config) => {
        observedTimeout = config.timeoutMs;
        observedMaximumBytes = config.maxResponseBytes;
        return { call: async () => ({ Code: 0, Data: null }) };
      },
      writeOutput: async () => undefined,
    });
    expect(observedTimeout).toBe(900_000);
    expect(observedMaximumBytes).toBe(100 * 1024 * 1024);
  });

  it("rejects unknown api-call names with registry discovery guidance", () => {
    expect(() => resolveApiCallEndpoint("FutureEndpoint")).toThrow(/sorftime endpoints/u);
  });

  it("uses registry history metadata even when a historical endpoint omits optional dates", async () => {
    const resolveToken = vi.fn(async () => ({ token: "history-sentinel", source: "environment" as const }));
    await expect(runEndpoint(endpoint("KeywordSearchResultTrend"), { keyword: "sentinel" }, {
      domain: "in",
      baseUrl: DEFAULT_BASE_URL,
      output: "json",
    }, undefined, {
      loadConfig: async () => ({}),
      resolveToken,
      writeOutput: async () => undefined,
    })).rejects.toThrow(/does not support historical backfill/u);
    expect(resolveToken).not.toHaveBeenCalled();
  });
});
