import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/endpoints.js";
import { ValidationError } from "../src/errors.js";
import {
  assertEndpointAllowed,
  billingFor,
  blockedReason,
  blockedReasons,
  ENDPOINT_BILLING,
  ENDPOINT_EFFECT,
  effectFor,
  spendsCoin,
  validateBillingCatalog,
  validateEffectCatalog,
} from "../src/policy.js";

const COIN_ENDPOINTS = [
  "ProductReviewsCollection",
  "GetFavoriteKeyword",
  "KeywordBatchSubscription",
  "KeywordBatchTaskUpdate",
  "BestSellerListSubscription",
  "ProductSellerSubscription",
  "ProductSellerTaskUpdate",
  "ASINSubscription",
];

const WRITE_ENDPOINTS = [
  "FavoriteKeyword",
  "ChangeFavoriteKeyword",
  "KeywordBatchSubscription",
  "KeywordBatchTaskUpdate",
  "BestSellerListSubscription",
  "BestSellerListDelete",
  "ProductSellerSubscription",
  "ProductSellerTaskUpdate",
  "ASINSubscription",
];

const DUAL_EFFECT_ENDPOINTS = [
  "KeywordBatchSubscription",
  "KeywordBatchTaskUpdate",
  "BestSellerListSubscription",
  "ProductSellerSubscription",
  "ProductSellerTaskUpdate",
  "ASINSubscription",
];

describe("endpoint policy catalogs", () => {
  it("classifies every registered endpoint exactly once on both axes", () => {
    expect(() => validateBillingCatalog()).not.toThrow();
    expect(() => validateEffectCatalog()).not.toThrow();
    expect(Object.keys(ENDPOINT_BILLING)).toHaveLength(ENDPOINTS.length);
    expect(Object.keys(ENDPOINT_EFFECT)).toHaveLength(ENDPOINTS.length);
  });

  it("rejects missing billing or effect classifications instead of inventing defaults", () => {
    expect(() => billingFor("NotAnEndpoint")).toThrow(ValidationError);
    expect(() => effectFor("NotAnEndpoint")).toThrow(ValidationError);
  });

  it("treats undocumented and recurring downstream costs as Coin-spending", () => {
    expect(billingFor("GetFavoriteKeyword")).toBe("unknown");
    expect(billingFor("KeywordBatchTaskUpdate")).toBe("recurring_coin");
    expect(billingFor("ProductSellerTaskUpdate")).toBe("recurring_coin");
    expect(spendsCoin("unknown")).toBe(true);
    const spending = Object.keys(ENDPOINT_BILLING).filter((name) => spendsCoin(billingFor(name)));
    expect(spending.sort()).toEqual([...COIN_ENDPOINTS].sort());
  });

  it("classifies all shared-state effects, including subscription creation", () => {
    const writes = Object.keys(ENDPOINT_EFFECT).filter((name) => effectFor(name) === "write");
    expect(writes.sort()).toEqual([...WRITE_ENDPOINTS].sort());
    expect(effectFor("CategoryRequest")).toBe("read");
  });
});

describe("default exposure policy", () => {
  it("leaves free and request-quota reads open", () => {
    for (const name of ["CategoryRequest", "ProductRequest", "AsinSalesVolume", "BestSellerListDataCollect", "CoinQuery"]) {
      expect(blockedReasons(name)).toEqual([]);
      expect(() => assertEndpointAllowed(name)).not.toThrow();
    }
  });

  it("requires the complete 2x2 override matrix for every dual-effect endpoint", () => {
    for (const name of DUAL_EFFECT_ENDPOINTS) {
      expect(blockedReasons(name).map((reason) => reason.kind)).toEqual(["coin", "write"]);
      expect(() => assertEndpointAllowed(name)).toThrow(/--allow-coin and --allow-write/u);

      expect(blockedReason(name, { allowCoin: true })?.kind).toBe("write");
      expect(() => assertEndpointAllowed(name, { allowCoin: true })).toThrow(/--allow-write/u);

      expect(blockedReason(name, { allowWrite: true })?.kind).toBe("coin");
      expect(() => assertEndpointAllowed(name, { allowWrite: true })).toThrow(/--allow-coin/u);

      expect(blockedReason(name, { allowCoin: true, allowWrite: true })).toBeUndefined();
      expect(() => assertEndpointAllowed(name, { allowCoin: true, allowWrite: true })).not.toThrow();
    }
  });

  it("keeps single-axis overrides independent", () => {
    expect(() => assertEndpointAllowed("BestSellerListDelete", { allowCoin: true })).toThrow(/--allow-write/u);
    expect(() => assertEndpointAllowed("ProductReviewsCollection", { allowWrite: true })).toThrow(/--allow-coin/u);
    expect(() => assertEndpointAllowed("BestSellerListDelete", { allowWrite: true })).not.toThrow();
    expect(() => assertEndpointAllowed("ProductReviewsCollection", { allowCoin: true })).not.toThrow();
  });

  it("fails closed on both axes for a missing catalog entry", () => {
    expect(blockedReasons("SomeUndocumentedEndpoint").map((reason) => reason.kind)).toEqual(["coin", "write"]);
    expect(() => assertEndpointAllowed("SomeUndocumentedEndpoint", { allowCoin: true })).toThrow(/--allow-write/u);
  });

  it("keeps exactly the intended union blocked while leaving 41 open", () => {
    const blocked = ENDPOINTS.filter((endpoint) => blockedReasons(endpoint.name).length > 0);
    expect(blocked).toHaveLength(11);
    expect(ENDPOINTS.length - blocked.length).toBe(41);
  });
});
