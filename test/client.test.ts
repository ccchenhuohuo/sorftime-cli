import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiEnvelopeCode,
  apiEnvelopeData,
  DEFAULT_BASE_URL,
  requestApi,
  validateCredentialDestination,
} from "../src/client.js";
import { ApiError, NetworkError, ValidationError } from "../src/errors.js";
import type { ApiRequestOptions } from "../src/types.js";

const options = {
  endpoint: "CoinQuery",
  domain: 7,
  body: {},
  token: "sentinel-secret-never-real",
  baseUrl: DEFAULT_BASE_URL,
  timeoutMs: 1_000,
  retries: 0,
} satisfies ApiRequestOptions;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Sorftime client", () => {
  it("constructs the canonical POST request and exact auth scheme", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ Code: 0, Data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await requestApi(options, fetchMock);
    expect(result).toEqual({ Code: 0, Data: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://standardapi.sorftime.com/api/CoinQuery?domain=7");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("BasicAuth sentinel-secret-never-real");
    expect(init?.body).toBe("{}");
  });

  it("reads both camelCase and PascalCase envelopes", () => {
    expect(apiEnvelopeCode({ Code: 0 })).toBe(0);
    expect(apiEnvelopeCode({ code: "501" })).toBe(501);
    expect(apiEnvelopeData({ DATA: [1, 2] })).toEqual([1, 2]);
  });

  it.each([10, 11])("raises typed business error %i without treating it as an empty page", async (code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code, message: "business response" }), { status: 200 }),
    );
    await expect(requestApi(options, fetchMock)).rejects.toMatchObject({ apiCode: code, exitCode: 5 } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 501, 694])("never retries account-global business code %i", async (code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ Code: code }), { status: 200 }),
    );
    await expect(requestApi({ ...options, retries: 5 }, fetchMock)).rejects.toMatchObject({ apiCode: code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts the loaded credential from upstream error text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ Code: 10, Message: `echo ${options.token}` }), { status: 200 }),
    );
    let message = "";
    try {
      await requestApi(options, fetchMock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[redacted credential]");
    expect(message).not.toContain(options.token);
  });

  it.each([408, 429, 503])("keeps HTTP %i transport retries separate from business codes", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Code: 0, Data: [] }), { status: 200 }));
    await expect(requestApi({ ...options, retries: 1 }, fetchMock)).resolves.toEqual({ Code: 0, Data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises a transport error for non-retryable non-2xx responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "nope" }), { status: 403, statusText: "Forbidden" }),
    );
    await expect(requestApi(options, fetchMock)).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON success responses unless exact raw output is requested", async () => {
    const html = "<html>proxy login</html>";
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    await expect(requestApi(options, invalidJson)).rejects.toMatchObject({
      message: "Sorftime API returned a non-JSON success response.",
    });
    const rawFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(` {"Code":0}\n`, { status: 200 }));
    await expect(requestApi({ ...options, rawResponse: true }, rawFetch)).resolves.toBe(` {"Code":0}\n`);
  });

  it("enforces the configured response-size limit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"Code":0}', { status: 200, headers: { "content-length": "10" } }),
    );
    await expect(requestApi({ ...options, maxResponseBytes: 5 }, fetchMock)).rejects.toThrow(/response exceeds/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-before-request"));
    const fetchMock = vi.fn<typeof fetch>();
    await expect(requestApi({ ...options, signal: controller.signal }, fetchMock)).rejects.toThrow("Request cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops while waiting to retry when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      queueMicrotask(() => controller.abort(new Error("stop-retry")));
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    });
    await expect(requestApi({ ...options, retries: 1, signal: controller.signal }, fetchMock)).rejects.toThrow("Request cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recursively redacts images, secret-shaped fields, and the actual credential", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ Code: 0 }), { status: 200 }));
    await requestApi({
      ...options,
      endpoint: "SimilarProductRealtimeRequest",
      body: {
        Image: "secret-image-payload",
        Authorization: `BasicAuth ${options.token}`,
        nested: { accountSk: "another-secret", values: [`prefix-${options.token}-suffix`] },
      },
      verbose: true,
    }, fetchMock);
    const logged = stderr.mock.calls.flat().join("");
    expect(logged).toContain("[image data:");
    for (const secret of ["secret-image-payload", "another-secret", options.token]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("accepts canonical and loopback origins", () => {
    expect(validateCredentialDestination(DEFAULT_BASE_URL)).toBe(DEFAULT_BASE_URL);
    expect(validateCredentialDestination("http://localhost:3210/api")).toBe("http://localhost:3210/api/");
    expect(validateCredentialDestination("http://127.0.0.1:3210/api/")).toBe("http://127.0.0.1:3210/api/");
    expect(validateCredentialDestination("http://[::1]:3210/api/")).toBe("http://[::1]:3210/api/");
  });

  it("allows Authorization on a loopback request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"Code":0}', { status: 200 }));
    await requestApi({ ...options, baseUrl: "http://127.0.0.1:3210/api/" }, fetchMock);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`BasicAuth ${options.token}`);
  });

  it("requires a deployment opt-in for an exact remote origin", () => {
    expect(() => validateCredentialDestination("https://collector.example/api/")).toThrow(/untrusted origin/u);
    expect(validateCredentialDestination(
      "https://collector.example/api/",
      "https://collector.example,https://other.example:8443",
    )).toBe("https://collector.example/api/");
    expect(() => validateCredentialDestination(
      "https://collector.example:8443/api/",
      "https://collector.example",
    )).toThrow(/untrusted origin/u);
  });

  it("honors the deployment allowlist for an exact remote request origin", async () => {
    vi.stubEnv("SORFTIME_TRUSTED_ORIGINS", "https://collector.example");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"Code":0}', { status: 200 }));
    await requestApi({ ...options, baseUrl: "https://collector.example/api/" }, fetchMock);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://collector.example/api/CoinQuery?domain=7");
  });

  it("rejects URL userinfo before logging or fetching", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn<typeof fetch>();
    await expect(requestApi({
      ...options,
      baseUrl: "https://url-user:url-password@standardapi.sorftime.com/api/",
      verbose: true,
    }, fetchMock)).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).not.toMatch(/url-user|url-password/u);
  });

  it("rejects an untrusted remote origin before attaching Authorization", async () => {
    vi.stubEnv("SORFTIME_TRUSTED_ORIGINS", "");
    const fetchMock = vi.fn<typeof fetch>();
    await expect(requestApi({ ...options, baseUrl: "https://collector.example/api/" }, fetchMock))
      .rejects.toThrow(/untrusted origin/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
