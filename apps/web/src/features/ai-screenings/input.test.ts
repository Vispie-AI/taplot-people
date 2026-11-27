import { describe, expect, it } from "vitest";

import { aiScreeningsRequestSchema, parseScreeningTime } from "./input";

const item = {
  sourceRecordId: "recAAA",
  sourceJobId: "recJOB",
  verdict: "strong",
  reason: "Shipped two interactive dramas",
  model: "claude-opus-5-5",
  screenedAt: "2026-11-26T09:00:27.740Z",
};

describe("ai screening input", () => {
  it("accepts a source record or a candidate id and defaults the criteria", () => {
    const parsed = aiScreeningsRequestSchema.parse({ items: [item] });
    expect(parsed.items[0]!.criteria).toEqual([]);
    expect(
      aiScreeningsRequestSchema.safeParse({
        items: [{ ...item, sourceRecordId: undefined, candidateId: "6f0a1c3e-52a4-4f5e-9d0a-0f6f6d3f7a11" }],
      }).success,
    ).toBe(true);
  });

  it("refuses an item that names no candidate, an unknown verdict, extra keys and empty batches", () => {
    expect(aiScreeningsRequestSchema.safeParse({ items: [{ ...item, sourceRecordId: undefined }] }).success).toBe(false);
    expect(aiScreeningsRequestSchema.safeParse({ items: [{ ...item, verdict: "pass" }] }).success).toBe(false);
    expect(aiScreeningsRequestSchema.safeParse({ items: [{ ...item, stage: "Hired" }] }).success).toBe(false);
    expect(aiScreeningsRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(aiScreeningsRequestSchema.safeParse({ items: [{ ...item, screenedAt: "yesterday" }] }).success).toBe(false);
  });

  it("reads a plain date as that day in Asia/Shanghai", () => {
    expect(parseScreeningTime("2026-11-26")!.toISOString()).toBe("2026-11-25T16:00:00.000Z");
    expect(parseScreeningTime("2026-11-26T01:02:03Z")!.toISOString()).toBe("2026-11-26T01:02:03.000Z");
    expect(parseScreeningTime("nope")).toBeUndefined();
    expect(parseScreeningTime(undefined)).toBeUndefined();
  });
});
