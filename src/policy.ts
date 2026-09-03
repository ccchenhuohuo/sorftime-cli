import { ENDPOINTS } from "./endpoints.js";
import { ValidationError } from "./errors.js";

/**
 * How an endpoint is charged upstream.
 *
 * - `free`            no quota and no Coin movement.
 * - `request`         consumes the account-global monthly request quota.
 * - `coin`            consumes Coin points once per call.
 * - `recurring_coin`  registers a subscription that keeps consuming Coin every period.
 * - `unknown`         the source documentation does not state a cost.
 */
export type BillingKind = "free" | "request" | "coin" | "recurring_coin" | "unknown";

/**
 * Exhaustive machine classification of all 52 endpoints.
 *
 * Never derive it from the human-readable `cost` string in `endpoints.ts`, which is
 * advisory prose meant for `--help`.
 */
export const ENDPOINT_BILLING: Readonly<Record<string, BillingKind>> = {
  // Category market
  CategoryTree: "request",
  CategoryRequest: "request",
  CategoryProducts: "request",
  CategoryTrend: "request",

  // Product
  ProductRequest: "request",
  ProductQuery: "request",
  AsinSalesVolume: "request",
  ProductVariationHistory: "request",
  ProductRealtimeRequest: "request",
  ProductRealtimeRequestStatusQuery: "request",
  ProductReviewsCollection: "coin",
  ProductReviewsCollectionStatusQuery: "free",
  ProductReviewsQuery: "request",
  SimilarProductRealtimeRequest: "request",
  SimilarProductRealtimeRequestStatusQuery: "free",
  SimilarProductRealtimeRequestCollection: "free",

  // Keywords
  KeywordQuery: "request",
  KeywordSearchResults: "request",
  KeywordRequest: "request",
  KeywordSearchResultTrend: "request",
  CategoryRequestKeyword: "request",
  ASINRequestKeyword: "request",
  KeywordProductRanking: "request",
  ASINKeywordRanking: "request",
  KeywordExtends: "request",
  FavoriteKeyword: "request",
  ChangeFavoriteKeyword: "request",
  GetFavoriteKeyword: "unknown",

  // Data monitoring
  KeywordBatchSubscription: "recurring_coin",
  KeywordTasks: "free",
  KeywordBatchTaskUpdate: "free",
  KeywordBatchScheduleList: "free",
  KeywordBatchScheduleDetail: "free",
  BestSellerListSubscription: "recurring_coin",
  BestSellerListTask: "free",
  BestSellerListDelete: "free",
  BestSellerListDataCollect: "free",
  ProductSellerSubscription: "recurring_coin",
  ProductSellerTasks: "free",
  ProductSellerTaskUpdate: "free",
  ProductSellerTaskScheduleList: "free",
  ProductSellerTaskScheduleDetail: "free",
  ASINSubscription: "recurring_coin",
  ASINSubscriptionQuery: "free",
  ASINSubscriptionCollection: "free",

  // Sorftime Agent
  ProductAssistant: "request",
  CategoryAssistant: "request",
  AIResultQuery: "request",
  AIResult: "free",

  // Account
  CoinQuery: "free",
  CoinStream: "free",
  RequestStreamMonth: "free",
};


/**
 * What a call does to shared account state.
 *
 * The CLI is distributed to several people who all hold the same account-level
 * Account-SK, so a write is not "my data" - it changes what everyone else sees.
 */
export type EndpointEffect = "read" | "write";

/** The five endpoints that create, modify, or delete shared account state. */
export const ENDPOINT_EFFECT: Readonly<Record<string, EndpointEffect>> = {
  FavoriteKeyword: "write",          // adds a term to the shared keyword dictionary
  ChangeFavoriteKeyword: "write",    // moves or deletes a dictionary term; body undocumented
  KeywordBatchTaskUpdate: "write",   // Update=9 deletes a keyword monitor
  BestSellerListDelete: "write",     // deletes a Best Seller monitor, not recoverable
  ProductSellerTaskUpdate: "write",  // modifies or deletes a seller/stock monitor
};

export function effectFor(endpoint: string): EndpointEffect {
  return ENDPOINT_EFFECT[endpoint] ?? "read";
}

/** Fails the build/test suite if the endpoint registry and the cost model drift apart. */
export function validateBillingCatalog(): void {
  const endpointNames = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
  const billingNames = new Set(Object.keys(ENDPOINT_BILLING));
  const missing = [...endpointNames].filter((name) => !billingNames.has(name));
  const extra = [...billingNames].filter((name) => !endpointNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(
      `Endpoint billing catalog mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
    );
  }
}

export function billingFor(endpoint: string): BillingKind {
  const billing = ENDPOINT_BILLING[endpoint];
  if (!billing) throw new ValidationError(`Endpoint '${endpoint}' has no billing classification.`);
  return billing;
}

/**
 * Fail-closed: an undocumented cost counts as Coin-spending. The source documentation
 * omits the cost for `GetFavoriteKeyword`, and an unpriced call is not safe to assume free.
 */
export function spendsCoin(billing: BillingKind): boolean {
  return billing === "coin" || billing === "recurring_coin" || billing === "unknown";
}

export interface PolicyOverrides {
  allowCoin?: boolean | undefined;
  allowWrite?: boolean | undefined;
}

export interface BlockedReason {
  kind: "coin" | "write";
  detail: string;
}

/**
 * What this deployment refuses to do by default.
 *
 * Coin is a separate purchased balance with no per-person allowance, and a
 * `recurring_coin` subscription keeps draining it every period long after the call
 * returns - one mistake is unbounded rather than one-off. Writes change state that
 * every other holder of the shared credential sees, and some of them delete a live
 * monitor with no undo. Both are refused unless an operator opts in for one call.
 */
export function blockedReason(endpointName: string, overrides: PolicyOverrides = {}): BlockedReason | undefined {
  // An endpoint absent from the catalog can only arrive through the raw `api call`
  // escape hatch. Its cost is unverifiable, so it takes the same fail-closed path.
  const billing = ENDPOINT_BILLING[endpointName] ?? "unknown";
  if (spendsCoin(billing) && overrides.allowCoin !== true) {
    return {
      kind: "coin",
      detail: billing === "unknown"
        ? "its upstream cost is undocumented, so it is treated as Coin-spending"
        : billing === "recurring_coin"
          ? "it registers a subscription that keeps spending Coin every period"
          : "it spends Coin points",
    };
  }
  if (effectFor(endpointName) === "write" && overrides.allowWrite !== true) {
    return { kind: "write", detail: "it creates, modifies, or deletes state on the shared account" };
  }
  return undefined;
}

export function assertEndpointAllowed(endpointName: string, overrides: PolicyOverrides = {}): void {
  const blocked = blockedReason(endpointName, overrides);
  if (!blocked) return;
  const flag = blocked.kind === "coin" ? "--allow-coin" : "--allow-write";
  throw new ValidationError(
    `${endpointName} is blocked: ${blocked.detail}. This deployment exposes free and request-quota reads only. `
    + `Pass ${flag} to override for a single call.`,
  );
}
