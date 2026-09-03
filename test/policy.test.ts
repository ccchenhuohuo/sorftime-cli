import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/endpoints.js";
import { ValidationError } from "../src/errors.js";
import {
  assertEndpointAllowed, billingFor, blockedReason, ENDPOINT_BILLING, ENDPOINT_EFFECT,
  effectFor, spendsCoin, validateBillingCatalog,
} from "../src/policy.js";

const COIN_ENDPOINTS = [
  "ProductReviewsCollection",
  "KeywordBatchSubscription",
  "BestSellerListSubscription",
  "ProductSellerSubscription",
  "ASINSubscription",
];

const WRITE_ENDPOINTS = [
  "FavoriteKeyword",
  "ChangeFavoriteKeyword",
  "KeywordBatchTaskUpdate",
  "BestSellerListDelete",
  "ProductSellerTaskUpdate",
];

describe("endpoint billing catalog", () => {
  it("classifies every registered endpoint exactly once", () => {
    expect(() => validateBillingCatalog()).not.toThrow();
    expect(Object.keys(ENDPOINT_BILLING)).toHaveLength(ENDPOINTS.length);
  });

  it("rejects an endpoint with no classification", () => {
    expect(() => billingFor("NotAnEndpoint")).toThrow(ValidationError);
  });

  it("treats an undocumented cost as Coin-spending", () => {
    expect(billingFor("GetFavoriteKeyword")).toBe("unknown");
    expect(spendsCoin("unknown")).toBe(true);
  });

  it("marks exactly the documented Coin and subscription endpoints as spending Coin", () => {
    const spending = Object.keys(ENDPOINT_BILLING).filter((name) => spendsCoin(billingFor(name)));
    expect(spending.sort()).toEqual([...COIN_ENDPOINTS, "GetFavoriteKeyword"].sort());
  });
});

describe("endpoint effect catalog", () => {
  it("marks exactly the five state-changing endpoints as writes", () => {
    expect(Object.keys(ENDPOINT_EFFECT).sort()).toEqual([...WRITE_ENDPOINTS].sort());
    for (const name of WRITE_ENDPOINTS) expect(effectFor(name)).toBe("write");
  });

  it("defaults an unlisted endpoint to read", () => {
    expect(effectFor("CategoryRequest")).toBe("read");
    expect(effectFor("SomeUndocumentedEndpoint")).toBe("read");
  });

  it("names only endpoints that exist in the registry", () => {
    const registered = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
    for (const name of Object.keys(ENDPOINT_EFFECT)) expect(registered.has(name)).toBe(true);
  });
});

describe("default exposure policy", () => {
  it("leaves free and request-quota reads open", () => {
    for (const name of ["CategoryRequest", "ProductRequest", "AsinSalesVolume", "BestSellerListDataCollect", "CoinQuery"]) {
      expect(blockedReason(name)).toBeUndefined();
      expect(() => assertEndpointAllowed(name)).not.toThrow();
    }
  });

  it("blocks Coin and recurring-Coin endpoints", () => {
    for (const name of COIN_ENDPOINTS) {
      expect(blockedReason(name)?.kind).toBe("coin");
      expect(() => assertEndpointAllowed(name)).toThrow(/blocked/u);
    }
  });

  it("blocks endpoints that change shared account state", () => {
    for (const name of WRITE_ENDPOINTS) {
      expect(blockedReason(name)?.kind).toBe("write");
      expect(() => assertEndpointAllowed(name)).toThrow(/state on the shared account/u);
    }
  });

  it("explains that a subscription keeps spending every period", () => {
    expect(() => assertEndpointAllowed("BestSellerListSubscription")).toThrow(/keeps spending Coin every period/u);
  });

  it("fails closed for an endpoint that reaches the raw escape hatch unclassified", () => {
    expect(() => assertEndpointAllowed("SomeUndocumentedEndpoint")).toThrow(/undocumented/u);
  });

  it("keeps the two overrides independent", () => {
    expect(() => assertEndpointAllowed("BestSellerListDelete", { allowCoin: true })).toThrow(/state on the shared account/u);
    expect(() => assertEndpointAllowed("ProductReviewsCollection", { allowWrite: true })).toThrow(/spends Coin/u);
    expect(() => assertEndpointAllowed("BestSellerListDelete", { allowWrite: true })).not.toThrow();
    expect(() => assertEndpointAllowed("ProductReviewsCollection", { allowCoin: true })).not.toThrow();
  });

  it("leaves the great majority of the catalog open", () => {
    const open = ENDPOINTS.filter((endpoint) => blockedReason(endpoint.name) === undefined);
    expect(open).toHaveLength(ENDPOINTS.length - COIN_ENDPOINTS.length - WRITE_ENDPOINTS.length - 1);
  });
});
