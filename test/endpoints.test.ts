import { describe, expect, it } from "vitest";
import { ENDPOINTS, findEndpoint } from "../src/endpoints.js";
import { commanderProperty, optionName } from "../src/input.js";

const expectedNames = [
  "CategoryTree",
  "CategoryRequest",
  "CategoryProducts",
  "CategoryTrend",
  "ProductRequest",
  "ProductQuery",
  "AsinSalesVolume",
  "ProductVariationHistory",
  "ProductRealtimeRequest",
  "ProductRealtimeRequestStatusQuery",
  "ProductReviewsCollection",
  "ProductReviewsCollectionStatusQuery",
  "ProductReviewsQuery",
  "SimilarProductRealtimeRequest",
  "SimilarProductRealtimeRequestStatusQuery",
  "SimilarProductRealtimeRequestCollection",
  "KeywordQuery",
  "KeywordSearchResults",
  "KeywordRequest",
  "KeywordSearchResultTrend",
  "CategoryRequestKeyword",
  "ASINRequestKeyword",
  "KeywordProductRanking",
  "ASINKeywordRanking",
  "KeywordExtends",
  "FavoriteKeyword",
  "ChangeFavoriteKeyword",
  "GetFavoriteKeyword",
  "KeywordBatchSubscription",
  "KeywordTasks",
  "KeywordBatchTaskUpdate",
  "KeywordBatchScheduleList",
  "KeywordBatchScheduleDetail",
  "BestSellerListSubscription",
  "BestSellerListTask",
  "BestSellerListDelete",
  "BestSellerListDataCollect",
  "ProductSellerSubscription",
  "ProductSellerTasks",
  "ProductSellerTaskUpdate",
  "ProductSellerTaskScheduleList",
  "ProductSellerTaskScheduleDetail",
  "ASINSubscription",
  "ASINSubscriptionQuery",
  "ASINSubscriptionCollection",
  "ProductAssistant",
  "CategoryAssistant",
  "AIResultQuery",
  "AIResult",
  "CoinQuery",
  "CoinStream",
  "RequestStreamMonth",
] as const;

function parameterKeys(endpointName: string): string[] {
  const endpoint = findEndpoint(endpointName);
  expect(endpoint, `missing endpoint ${endpointName}`).toBeDefined();
  return endpoint?.parameters.map((parameter) => parameter.key) ?? [];
}

describe("endpoint registry", () => {
  it("contains all 52 documented endpoint names exactly once", () => {
    const names = ENDPOINTS.map((endpoint) => endpoint.name);

    expect(names).toHaveLength(52);
    expect(new Set(names).size).toBe(52);
    expect([...names].sort()).toEqual([...expectedNames].sort());
  });

  it("has the documented group counts", () => {
    const counts = Object.fromEntries(
      ["category", "product", "keyword", "monitor", "agent", "account"].map((group) => [
        group,
        ENDPOINTS.filter((endpoint) => endpoint.group === group).length,
      ]),
    );

    expect(counts).toEqual({
      category: 4,
      product: 12,
      keyword: 12,
      monitor: 17,
      agent: 4,
      account: 3,
    });
  });

  it("uses unique command names within every group", () => {
    for (const group of new Set(ENDPOINTS.map((endpoint) => endpoint.group))) {
      const commands = ENDPOINTS.filter((endpoint) => endpoint.group === group).map((endpoint) => endpoint.command);
      expect(new Set(commands).size, `duplicate command in ${group}`).toBe(commands.length);
    }
  });

  it("finds endpoints by API name or command without case sensitivity", () => {
    expect(findEndpoint("productrequest")?.name).toBe("ProductRequest");
    expect(findEndpoint("BEST-SELLERS")?.name).toBe("CategoryRequest");
    expect(findEndpoint("does-not-exist")).toBeUndefined();
  });
});

describe("parameter keys and CLI mappings", () => {
  it("preserves the API's inconsistent ASIN casing per endpoint", () => {
    expect(parameterKeys("ProductRequest")[0]).toBe("ASIN");
    expect(parameterKeys("ProductSellerSubscription")[0]).toBe("Asin");
    expect(parameterKeys("ASINSubscription")[0]).toBe("Asins");
    expect(parameterKeys("ProductAssistant")[0]).toBe("Asin");
  });

  it("preserves unusual documented keys instead of normalizing API JSON", () => {
    expect(parameterKeys("ProductReviewsQuery")).toContain("Querystartdt");
    expect(parameterKeys("ProductReviewsQuery")).not.toContain("QueryStartDt");
    expect(parameterKeys("BestSellerListDataCollect")).toEqual([
      "NodeId",
      "BestSellerListType",
      "QueryDate",
    ]);
  });

  it.each([
    ["ASIN", "asin", "asin"],
    ["Asin", "asin", "asin"],
    ["Asins", "asins", "asins"],
    ["NodeId", "node-id", "nodeId"],
    ["QueryTrendStartDt", "query-trend-start-dt", "queryTrendStartDt"],
    ["BestSellerListType", "best-seller-list-type", "bestSellerListType"],
    ["Querystartdt", "querystartdt", "querystartdt"],
  ])("maps %s to --%s and Commander property %s", (key, option, property) => {
    expect(optionName(key)).toBe(option);
    expect(commanderProperty(key)).toBe(property);
  });

  it("does not create colliding Commander properties within an endpoint", () => {
    for (const endpoint of ENDPOINTS) {
      const properties = endpoint.parameters.map((parameter) => commanderProperty(parameter.key));
      expect(new Set(properties).size, `property collision in ${endpoint.name}`).toBe(properties.length);
    }
  });

  it("marks only the four endpoints with unknown request schemas as undocumented", () => {
    const undocumented = ENDPOINTS
      .filter((endpoint) => endpoint.undocumentedParameters)
      .map((endpoint) => endpoint.name)
      .sort();

    expect(undocumented).toEqual([
      "ChangeFavoriteKeyword",
      "GetFavoriteKeyword",
      "ProductSellerTaskUpdate",
      "ProductSellerTasks",
    ]);
  });

  it("keeps runtime-verified required fields in the registry used by help and discovery", () => {
    const keywordPattern = findEndpoint("KeywordQuery")?.parameters.find((parameter) => parameter.key === "Pattern");
    expect(keywordPattern).toMatchObject({ required: true, sourceOptionalButRuntimeRequired: true });

    const aiParameters = findEndpoint("AIResultQuery")?.parameters ?? [];
    for (const key of ["QueryStart", "QueryEnd"]) {
      expect(aiParameters.find((parameter) => parameter.key === key)).toMatchObject({
        required: true,
        sourceOptionalButRuntimeRequired: true,
      });
    }

    expect(findEndpoint("KeywordProductRanking")?.parameters.find((parameter) => parameter.key === "Month"))
      .toMatchObject({ requiredWhen: { marketplaces: ["US"] } });
  });

  it("registers history behavior rather than maintaining a runner-side endpoint table", () => {
    expect(findEndpoint("CategoryTrend")?.history).toEqual({ mode: "always" });
    expect(findEndpoint("KeywordSearchResultTrend")?.history).toEqual({ mode: "always" });
    expect(findEndpoint("ProductRequest")?.history).toEqual({
      mode: "when-fields-present",
      fields: ["QueryTrendStartDt", "QueryTrendEndDt"],
    });
  });

  it("gives every auto-paginated endpoint an explicit row path and safe terminal rule", () => {
    const paginated = ENDPOINTS.filter((item) => item.pagination);
    expect(paginated.length).toBeGreaterThan(0);
    for (const item of paginated) {
      expect(item.pagination?.termination).toBe("empty-page");
      expect(item.pagination?.rowPath).toBeDefined();
    }
    expect(findEndpoint("CategoryProducts")?.pagination?.rowPath).toEqual(["Data", "Products"]);
    expect(findEndpoint("KeywordQuery")?.pagination?.rowPath).toEqual(["Data"]);
  });

  it("retains the measured CategoryTree timeout in the registry", () => {
    expect(findEndpoint("CategoryTree")?.timeoutMs).toBe(900_000);
  });
});
