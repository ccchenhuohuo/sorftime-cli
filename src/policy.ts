import { ENDPOINTS } from "./endpoints.js";
import { ValidationError } from "./errors.js";

/**
 * The worst cost consequence an endpoint invocation can have, including downstream
 * monitoring it creates, resumes, or changes. This is deliberately stricter than the
 * advisory price of the HTTP call itself.
 *
 * - `free`            no quota use and cannot enable Coin movement.
 * - `request`         consumes the account-global monthly request quota.
 * - `coin`            consumes Coin points once per call.
 * - `recurring_coin`  can create, start, or change monitoring that consumes Coin over time.
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
  KeywordBatchTaskUpdate: "recurring_coin", // Update=2 can resume Coin-billed monitoring
  KeywordBatchScheduleList: "free",
  KeywordBatchScheduleDetail: "free",
  BestSellerListSubscription: "recurring_coin",
  BestSellerListTask: "free",
  BestSellerListDelete: "free",
  BestSellerListDataCollect: "free",
  ProductSellerSubscription: "recurring_coin",
  ProductSellerTasks: "free",
  ProductSellerTaskUpdate: "recurring_coin", // undocumented body; fail closed on worst effect
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

/** Exhaustive effect classification for the same 52-endpoint registry. */
export const ENDPOINT_EFFECT: Readonly<Record<string, EndpointEffect>> = {
  // Category market
  CategoryTree: "read",
  CategoryRequest: "read",
  CategoryProducts: "read",
  CategoryTrend: "read",

  // Product
  ProductRequest: "read",
  ProductQuery: "read",
  AsinSalesVolume: "read",
  ProductVariationHistory: "read",
  ProductRealtimeRequest: "read",
  ProductRealtimeRequestStatusQuery: "read",
  ProductReviewsCollection: "read",
  ProductReviewsCollectionStatusQuery: "read",
  ProductReviewsQuery: "read",
  SimilarProductRealtimeRequest: "read",
  SimilarProductRealtimeRequestStatusQuery: "read",
  SimilarProductRealtimeRequestCollection: "read",

  // Keywords
  KeywordQuery: "read",
  KeywordSearchResults: "read",
  KeywordRequest: "read",
  KeywordSearchResultTrend: "read",
  CategoryRequestKeyword: "read",
  ASINRequestKeyword: "read",
  KeywordProductRanking: "read",
  ASINKeywordRanking: "read",
  KeywordExtends: "read",
  FavoriteKeyword: "write",
  ChangeFavoriteKeyword: "write",
  GetFavoriteKeyword: "read",

  // Data monitoring
  KeywordBatchSubscription: "write",
  KeywordTasks: "read",
  KeywordBatchTaskUpdate: "write",
  KeywordBatchScheduleList: "read",
  KeywordBatchScheduleDetail: "read",
  BestSellerListSubscription: "write",
  BestSellerListTask: "read",
  BestSellerListDelete: "write",
  BestSellerListDataCollect: "read",
  ProductSellerSubscription: "write",
  ProductSellerTasks: "read",
  ProductSellerTaskUpdate: "write",
  ProductSellerTaskScheduleList: "read",
  ProductSellerTaskScheduleDetail: "read",
  ASINSubscription: "write",
  ASINSubscriptionQuery: "read",
  ASINSubscriptionCollection: "read",

  // Sorftime Agent
  ProductAssistant: "read",
  CategoryAssistant: "read",
  AIResultQuery: "read",
  AIResult: "read",

  // Account
  CoinQuery: "read",
  CoinStream: "read",
  RequestStreamMonth: "read",
};

export function effectFor(endpoint: string): EndpointEffect {
  const effect = ENDPOINT_EFFECT[endpoint];
  if (!effect) throw new ValidationError(`Endpoint '${endpoint}' has no effect classification.`);
  return effect;
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

/** Fails the build/test suite if the endpoint registry and effect model drift apart. */
export function validateEffectCatalog(): void {
  const endpointNames = new Set(ENDPOINTS.map((endpoint) => endpoint.name));
  const effectNames = new Set(Object.keys(ENDPOINT_EFFECT));
  const missing = [...endpointNames].filter((name) => !effectNames.has(name));
  const extra = [...effectNames].filter((name) => !endpointNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(
      `Endpoint effect catalog mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
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
export function blockedReasons(endpointName: string, overrides: PolicyOverrides = {}): BlockedReason[] {
  // Missing catalog entries fail closed on both independent axes. `api call` rejects
  // unknown endpoint names even earlier, but this keeps the policy safe in isolation.
  const billing = ENDPOINT_BILLING[endpointName] ?? "unknown";
  const effect = ENDPOINT_EFFECT[endpointName] ?? "write";
  const reasons: BlockedReason[] = [];
  if (spendsCoin(billing) && overrides.allowCoin !== true) {
    reasons.push({
      kind: "coin",
      detail: billing === "unknown"
        ? "its upstream cost is undocumented, so it is treated as Coin-spending"
        : billing === "recurring_coin"
          ? "it can start or change monitoring that keeps spending Coin every period"
          : "it spends Coin points",
    });
  }
  if (effect === "write" && overrides.allowWrite !== true) {
    reasons.push({ kind: "write", detail: "it creates, modifies, or deletes state on the shared account" });
  }
  return reasons;
}

export function blockedReason(endpointName: string, overrides: PolicyOverrides = {}): BlockedReason | undefined {
  return blockedReasons(endpointName, overrides)[0];
}

export function assertEndpointAllowed(endpointName: string, overrides: PolicyOverrides = {}): void {
  const blocked = blockedReasons(endpointName, overrides);
  if (blocked.length === 0) return;
  const flags = blocked.map((reason) => reason.kind === "coin" ? "--allow-coin" : "--allow-write");
  const flagText = flags.length === 1 ? flags[0] : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
  throw new ValidationError(
    `${endpointName} is blocked: ${blocked.map((reason) => reason.detail).join("; ")}. `
    + `Missing single-call override${flags.length === 1 ? "" : "s"}: ${flagText}.`,
  );
}

// Fail during CLI startup as well as in tests if either policy catalog drifts.
validateBillingCatalog();
validateEffectCatalog();
