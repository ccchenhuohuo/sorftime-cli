#!/usr/bin/env node
import { Command } from 'commander';

type ParameterType = "string" | "integer" | "number" | "boolean" | "string[]" | "json" | "image";
interface ParameterSpec {
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
interface EndpointSpec {
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
    history?: {
        mode: "always";
    } | {
        mode: "when-fields-present";
        fields: readonly string[];
    };
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

declare function resolveApiCallEndpoint(endpointName: string): EndpointSpec;
declare function createProgram(): Command;
declare function runCli(argv?: string[]): Promise<void>;

export { createProgram, resolveApiCallEndpoint, runCli };
