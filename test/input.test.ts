import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEndpoint } from "../src/endpoints.js";
import { ValidationError } from "../src/errors.js";
import { buildRequestBody } from "../src/input.js";
import type { EndpointSpec } from "../src/types.js";

function endpoint(name: string): EndpointSpec {
  const value = findEndpoint(name);
  if (!value) throw new Error(`Test fixture endpoint not found: ${name}`);
  return value;
}

describe("request-body coercion", () => {
  // Verified live 2026-09-03: ProductRequest returns Code 0 / Data null / no charge for a JSON
  // array, at any length. Only a comma-separated string returns data. Do not "fix" this back
  // into an array to match the source documentation's batch example, which is wrong.
  it("serializes repeatable/comma-separated ASIN input as one comma-separated string", async () => {
    await expect(buildRequestBody(endpoint("ProductRequest"), {
      asin: ["B000TEST01,B000TEST02", "B000TEST03"],
      trend: "2",
    })).resolves.toEqual({
      ASIN: "B000TEST01,B000TEST02,B000TEST03",
      Trend: 2,
    });
  });

  it("serializes a single ASIN as a bare string, never a one-element array", async () => {
    const body = await buildRequestBody(endpoint("ProductRequest"), { asin: ["B000TEST01"] });
    expect(body.ASIN).toBe("B000TEST01");
    expect(Array.isArray(body.ASIN)).toBe(false);
  });

  it("applies ProductRequest CSV wire encoding to raw JSON and raw files", async () => {
    const expected = { ASIN: "B000TEST01,B000TEST02", Trend: 2 };
    await expect(buildRequestBody(endpoint("ProductRequest"), {
      data: '{"ASIN":["B000TEST01","B000TEST02"],"Trend":2}',
    })).resolves.toEqual(expected);

    const directory = await mkdtemp(join(tmpdir(), "sorftime-input-"));
    const path = join(directory, "body.json");
    await writeFile(path, '{"ASIN":["B000TEST01","B000TEST02"],"Trend":2}');
    await expect(buildRequestBody(endpoint("ProductRequest"), { dataFile: path })).resolves.toEqual(expected);
  });

  // Verified live 2026-09-03: each of these returns business code 10 when the parameter is
  // omitted, even though the source documentation marks it optional. Fail locally instead.
  it("requires KeywordQuery --pattern", async () => {
    await expect(buildRequestBody(endpoint("KeywordQuery"), { pageIndex: "1" }))
      .rejects.toThrow(/Missing required option --pattern/u);
    await expect(buildRequestBody(endpoint("KeywordQuery"), { pattern: '{"RankCondition":[1,1000]}' }))
      .resolves.toMatchObject({ Pattern: { RankCondition: [1, 1000] } });
  });

  it("requires AIResultQuery date range", async () => {
    await expect(buildRequestBody(endpoint("AIResultQuery"), { method: "0" }))
      .rejects.toThrow(/Missing required option --query-start/u);
    await expect(buildRequestBody(endpoint("AIResultQuery"), { method: "0", queryStart: "2026-08-28", queryEnd: "2026-09-03" }))
      .resolves.toMatchObject({ Method: 0 });
  });

  it("requires KeywordProductRanking --month on US only", async () => {
    await expect(buildRequestBody(endpoint("KeywordProductRanking"), { keyword: "bluetooth speaker" }, "US"))
      .rejects.toThrow(/Missing required option --month/u);
    await expect(buildRequestBody(endpoint("KeywordProductRanking"), { keyword: "bluetooth speaker", month: "2026-07" }, "US"))
      .resolves.toMatchObject({ Month: "2026-07" });
    await expect(buildRequestBody(endpoint("KeywordProductRanking"), { keyword: "bluetooth speaker" }, "DE"))
      .resolves.toMatchObject({ Keyword: "bluetooth speaker" });
  });

  it("keeps the array encoding for parameters the API documents as arrays", async () => {
    const body = await buildRequestBody(endpoint("CoinStream"), { queryDate: ["2026-08-01", "2026-08-31"] });
    expect(body.QueryDate).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("coerces integers, JSON objects, and date strings", async () => {
    await expect(buildRequestBody(endpoint("KeywordQuery"), {
      pattern: '{"RankCondition":[1,1000]}',
      pageIndex: "2",
      pageSize: "200",
    })).resolves.toEqual({
      Pattern: { RankCondition: [1, 1000] },
      PageIndex: 2,
      PageSize: 200,
    });

    await expect(buildRequestBody(endpoint("ASINKeywordRanking"), {
      keyword: "sentinel keyword",
      asin: "B000TEST01",
      queryStart: "2026-01-02",
      queryEnd: "2026-02-03",
      page: "1",
    })).resolves.toMatchObject({
      QueryStart: "2026-01-02",
      QueryEnd: "2026-02-03",
      Page: 1,
    });
  });

  it("serializes exact API key casing from normalized CLI properties", async () => {
    await expect(buildRequestBody(endpoint("ProductSellerSubscription"), {
      asin: "B000TEST01",
      checkStock: "1",
      period: "1|1|1",
    })).resolves.toEqual({ Asin: "B000TEST01", CheckStock: 1, Period: "1|1|1" });

    await expect(buildRequestBody(endpoint("ASINSubscription"), {
      asins: "+,B000TEST01,1",
    })).resolves.toEqual({ Asins: "+,B000TEST01,1" });

    await expect(buildRequestBody(endpoint("ProductReviewsQuery"), {
      asin: "B000TEST01",
      querystartdt: "2026-01-02",
    })).resolves.toEqual({ ASIN: "B000TEST01", Querystartdt: "2026-01-02" });
  });

  it("accepts raw JSON, preserves unknown fields, and lets typed options override it", async () => {
    await expect(buildRequestBody(endpoint("CategoryProducts"), {
      data: '{"NodeId":"raw-node","Page":1,"FutureField":"sentinel"}',
      nodeId: "typed-node",
      page: "3",
    })).resolves.toEqual({
      NodeId: "typed-node",
      Page: 3,
      FutureField: "sentinel",
    });
  });

  it("allows raw JSON for endpoints whose typed schema is undocumented", async () => {
    await expect(buildRequestBody(endpoint("ProductSellerTaskUpdate"), {
      data: '{"TaskId":"sentinel-task","Update":1}',
    })).resolves.toEqual({ TaskId: "sentinel-task", Update: 1 });
  });
});

describe("request-body validation", () => {
  it("requires documented required parameters from options or raw JSON", async () => {
    await expect(buildRequestBody(endpoint("CategoryRequest"), {})).rejects.toThrow(
      "Missing required option --node-id",
    );
    await expect(buildRequestBody(endpoint("CategoryRequest"), {
      data: '{"NodeId":"sentinel-node"}',
    })).resolves.toEqual({ NodeId: "sentinel-node" });
  });

  it.each([
    ["CategoryTrend", { nodeId: "sentinel-node", trendIndex: "16" }, "TrendIndex must be at most 15"],
    ["ProductRealtimeRequest", { asin: "B000TEST01", update: "0" }, "Update must be at least 1"],
    ["KeywordBatchTaskUpdate", { taskId: "1", update: "3" }, "Update must be one of: 0, 1, 2, 9"],
    ["KeywordQuery", { pageSize: "19" }, "PageSize must be at least 20"],
  ])("enforces numeric bounds and choices for %s", async (name, options, message) => {
    await expect(buildRequestBody(endpoint(name), options)).rejects.toThrow(message);
  });

  it.each([
    ["CategoryRequest", { nodeId: "sentinel-node", queryStart: "2026-02-30" }, "valid date"],
    ["KeywordSearchResultTrend", { keyword: "sentinel", queryStart: "2026-13" }, "YYYY-MM format"],
    ["BestSellerListDataCollect", {
      nodeId: "sentinel-node",
      bestSellerListType: "5",
      queryDate: "2026-01-01 24",
    }, "YYYY-MM-DD HH format"],
  ])("validates date-like formats for %s", async (name, options, message) => {
    await expect(buildRequestBody(endpoint(name), options)).rejects.toThrow(message);
  });

  it("limits ProductRequest batches to ten ASINs", async () => {
    const asins = Array.from({ length: 11 }, (_, index) => `B000TEST${String(index).padStart(2, "0")}`);
    await expect(buildRequestBody(endpoint("ProductRequest"), { asin: asins })).rejects.toThrow(
      "at most 10 ASINs",
    );
  });

  it("rejects empty and null required values after raw/typed merging", async () => {
    await expect(buildRequestBody(endpoint("ProductRequest"), { data: '{"ASIN":[]}' }))
      .rejects.toThrow(/Missing required option --asin/u);
    await expect(buildRequestBody(endpoint("ProductRequest"), { asin: ["", "  "] }))
      .rejects.toThrow(/Missing required option --asin/u);
    await expect(buildRequestBody(endpoint("KeywordQuery"), { data: '{"Pattern":null}' }))
      .rejects.toThrow(/Missing required option --pattern/u);
    await expect(buildRequestBody(endpoint("AIResultQuery"), {
      data: '{"Method":0,"QueryStart":null,"QueryEnd":"2026-09-03"}',
    })).rejects.toThrow(/Missing required option --query-start/u);
  });

  it("validates AI task date ordering and the seven-calendar-day limit", async () => {
    await expect(buildRequestBody(endpoint("AIResultQuery"), {
      method: "0", queryStart: "2026-09-03", queryEnd: "2026-09-02",
    })).rejects.toThrow(/QueryStart must not be after QueryEnd/u);
    await expect(buildRequestBody(endpoint("AIResultQuery"), {
      method: "0", queryStart: "2026-08-27", queryEnd: "2026-09-03",
    })).rejects.toThrow(/at most 7 calendar days/u);
    await expect(buildRequestBody(endpoint("AIResultQuery"), {
      method: "0", queryStart: "2026-08-28", queryEnd: "2026-09-03",
    })).resolves.toMatchObject({ QueryStart: "2026-08-28", QueryEnd: "2026-09-03" });
  });

  it("applies choices to raw fields as well as typed flags", async () => {
    await expect(buildRequestBody(endpoint("ProductQuery"), {
      data: '{"Query":1,"QueryType":"17","Pattern":"sentinel"}',
    })).rejects.toThrow(/QueryType must be one of/u);
    await expect(buildRequestBody(endpoint("ProductReviewsCollection"), {
      data: '{"ASIN":"B000TEST01","Mode":0,"OnlyPurchase":0}',
    })).rejects.toThrow(/OnlyPurchase must be one of: 1/u);
  });

  it("requires both single-condition ProductQuery fields, but permits raw multi-condition input", async () => {
    await expect(buildRequestBody(endpoint("ProductQuery"), { queryType: "3" })).rejects.toThrow(
      "requires --query-type and --pattern",
    );
    await expect(buildRequestBody(endpoint("ProductQuery"), {
      data: '{"Query":2,"Conditions":[{"QueryType":"3","Pattern":"sentinel-brand"}]}',
    })).resolves.toEqual({
      Query: 2,
      Conditions: [{ QueryType: "3", Pattern: "sentinel-brand" }],
    });
  });

  it("requires Area only for desktop keyword monitoring", async () => {
    await expect(buildRequestBody(endpoint("KeywordBatchSubscription"), {
      keyword: "sentinel keyword",
      mode: "0",
    })).rejects.toThrow("requires --area");

    await expect(buildRequestBody(endpoint("KeywordBatchSubscription"), {
      keyword: "sentinel keyword",
      mode: "1",
    })).resolves.toEqual({ Keyword: ["sentinel keyword"], Mode: 1 });
  });

  it("requires exactly two CoinStream dates", async () => {
    await expect(buildRequestBody(endpoint("CoinStream"), {
      queryDate: "2026-01-01",
    })).rejects.toThrow("requires exactly two values");

    await expect(buildRequestBody(endpoint("CoinStream"), {
      queryDate: ["2026-01-01", "2026-06-01"],
    })).resolves.toEqual({ QueryDate: ["2026-01-01", "2026-06-01"] });
  });

  it("requires a ProductRequest trend start when an end is provided", async () => {
    await expect(buildRequestBody(endpoint("ProductRequest"), {
      asin: "B000TEST01",
      queryTrendEndDt: "2026-02-01",
    })).rejects.toThrow("requires --query-trend-start-dt");
  });

  it("rejects conflicting raw input modes and non-object JSON", async () => {
    await expect(buildRequestBody(endpoint("CoinQuery"), {
      data: "{}",
      dataFile: "/tmp/sentinel-never-read.json",
    })).rejects.toThrow("Use only one of --data, --data-file, or --stdin");

    await expect(buildRequestBody(endpoint("CoinQuery"), { data: "[]" })).rejects.toThrow(
      "must contain a JSON object",
    );
    await expect(buildRequestBody(endpoint("CoinQuery"), { data: "{" })).rejects.toBeInstanceOf(ValidationError);
  });
});
