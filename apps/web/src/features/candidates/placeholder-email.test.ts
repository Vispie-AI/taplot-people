import { describe, expect, it } from "vitest";

import { isBossPlaceholderEmail } from "./placeholder-email";

describe("isBossPlaceholderEmail", () => {
  it("recognises both placeholder generations", () => {
    expect(isBossPlaceholderEmail(`${"ab12".repeat(16)}@boss.invalid`)).toBe(true);
    expect(isBossPlaceholderEmail("boss-0123456789abcdef01234567@example.invalid")).toBe(true);
    expect(isBossPlaceholderEmail("BOSS-0123456789ABCDEF01234567@Example.Invalid")).toBe(true);
  });

  it("rejects real, malformed and other-length addresses", () => {
    expect(isBossPlaceholderEmail("person@example.test")).toBe(false);
    expect(isBossPlaceholderEmail("boss-0123@example.invalid")).toBe(false);
    expect(isBossPlaceholderEmail(`${"a".repeat(63)}@boss.invalid`)).toBe(false);
    expect(isBossPlaceholderEmail("boss-0123456789abcdef01234567@boss.invalid")).toBe(false);
    expect(isBossPlaceholderEmail(null)).toBe(false);
    expect(isBossPlaceholderEmail("")).toBe(false);
  });
});
