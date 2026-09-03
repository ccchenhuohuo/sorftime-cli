import { describe, expect, it } from "vitest";
import { prepareOutput, serializeOutput } from "../src/output.js";

describe("output serialization", () => {
  it("unwraps Data case-insensitively and selects a path", () => {
    const value = { Code: 0, Data: { rows: [{ ASIN: "B000TEST" }] } };
    expect(prepareOutput(value, { format: "json", dataOnly: true, select: "rows.0.ASIN" })).toBe("B000TEST");
  });

  it("keeps null, empty arrays, and zero distinct under --data-only", () => {
    expect(prepareOutput({ Code: 0, Data: null }, { format: "json", dataOnly: true })).toBeNull();
    expect(prepareOutput({ Code: 0, Data: [] }, { format: "json", dataOnly: true })).toEqual([]);
    expect(prepareOutput({ Code: 0, Data: 0 }, { format: "json", dataOnly: true })).toBe(0);
  });

  it("rejects --data-only when the response has no Data field", () => {
    expect(() => prepareOutput({ Code: 0 }, { format: "json", dataOnly: true })).toThrow(/requires a Data\/data field/u);
  });

  it("emits valid CSV with nested fields escaped", () => {
    const output = serializeOutput([{ a: "hello,world", nested: { ok: true } }], { format: "csv" });
    expect(output).toBe('a,nested\n"hello,world","{""ok"":true}"');
  });

  it("emits one JSON value per line", () => {
    expect(serializeOutput([{ id: 1 }, { id: 2 }], { format: "jsonl" })).toBe('{"id":1}\n{"id":2}');
  });

  it("preserves exact strings for raw serialization", () => {
    expect(serializeOutput(` {"Code":0}\n`, { format: "raw" })).toBe(` {"Code":0}\n`);
  });
});
