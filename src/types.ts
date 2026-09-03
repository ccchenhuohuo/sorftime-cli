export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ParameterType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "string[]"
  | "json"
  | "image";

export interface ParameterSpec {
  key: string;
  type: ParameterType;
  description: string;
  required?: boolean;
  /** The upstream document says optional, but live validation requires the value. */
  sourceOptionalButRuntimeRequired?: boolean;
  /** A marketplace-specific required rule enforced from this registry entry. */
  requiredWhen?: {
    marketplaces: readonly string[];
    reason: string;
  };
  variadic?: boolean;
  /**
   * Wire encoding for a `string[]` parameter. Defaults to a JSON array.
   * `csv` joins the values into one comma-separated string, which some endpoints
   * require even though the source documentation shows an array example.
   */
  wire?: "csv";
  choices?: readonly (string | number)[];
  min?: number;
  max?: number;
  format?: "date" | "month" | "date-hour";
}

export interface EndpointSpec {
  name: string;
  group: "category" | "product" | "keyword" | "monitor" | "agent" | "account";
  command: string;
  aliases?: readonly string[];
  summary: string;
  cost: string;
  parameters: readonly ParameterSpec[];
  timeoutMs?: number;
  undocumentedParameters?: boolean;
  unsafeRetry?: boolean;
  history?:
    | { mode: "always" }
    | { mode: "when-fields-present"; fields: readonly string[] };
  dateRanges?: readonly {
    startKey: string;
    endKey: string;
    maxCalendarDays?: number;
  }[];
  pagination?: {
    pageKey: "Page" | "PageIndex";
    pageSizeKey?: "PageSize";
    defaultPageSize: number;
    /** Exact, case-insensitive path to the result rows. An empty path means a root array. */
    rowPath: readonly string[];
    /** Empty/null pages are the only generic terminal signal we can prove safely. */
    termination: "empty-page";
  };
}

export const OUTPUT_FORMATS = ["json", "jsonl", "yaml", "csv", "table", "raw"] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export interface StoredConfig {
  domain?: string | number;
  baseUrl?: string;
  timeoutMs?: number;
  output?: OutputFormat;
}

export interface ApiRequestOptions {
  endpoint: string;
  domain: number;
  body: JsonObject;
  token: string;
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  verbose?: boolean;
  rawResponse?: boolean;
  userAgent?: string;
  maxResponseBytes?: number;
}

export interface GlobalOptions {
  domain?: string;
  baseUrl?: string;
  timeout?: string;
  retries?: string;
  output?: OutputFormat;
  select?: string;
  dataOnly?: boolean;
  outputFile?: string;
  compact?: boolean;
  verbose?: boolean;
  force?: boolean;
  retryUnsafe?: boolean;
  allowCoin?: boolean;
  allowWrite?: boolean;
  allPages?: boolean;
  maxPages?: string;
  pageDelay?: string;
}
