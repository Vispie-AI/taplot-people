import { describe, expect, it } from "vitest";

import {
  cleanDirectoryFilters,
  directoryOrigin,
  buildCandidatesDirectoryUrl,
} from "./origin";
import {
  buildJobShortUrl,
  buildSavedFilterShortUrl,
  expandRoleAliases,
  findJobByCode,
  generateShortId,
  isShortId,
  normalizeShortCode,
  readableFilterTitle,
  type DirectoryJobRef,
} from "./short-links";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const JOB_C = "33333333-3333-4333-8333-333333333333";

const jobs: DirectoryJobRef[] = [
  { id: JOB_A, title: "游戏剧情策划实习", slug: "game-narrative-intern", shortCode: "narr-jr" },
  { id: JOB_B, title: "Backend Engineer", slug: "backend-engineer", shortCode: null },
  { id: JOB_C, title: "Growth Lead", slug: "growth-lead", shortCode: "growth" },
];

describe("short ids", () => {
  it("generates 7 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generateShortId();
      expect(id).toHaveLength(7);
      expect(isShortId(id)).toBe(true);
      expect(id).not.toMatch(/[01ilo]/);
    }
  });

  it("is deterministic for an injected random source", () => {
    expect(generateShortId(() => 0)).toBe("2222222");
  });

  it("rejects anything that is not a short id", () => {
    for (const bad of ["", "abc", "ABCDEFG", "abcdefgh", "a1b2c3d", "11111111-1111-4111-8111-111111111111", null, undefined]) {
      expect(isShortId(bad as string)).toBe(false);
    }
  });
});

describe("normalizeShortCode", () => {
  it("lower-cases, joins words with hyphens and trims", () => {
    expect(normalizeShortCode("  Narr JR ")).toBe("narr-jr");
    expect(normalizeShortCode("growth_lead")).toBe("growth-lead");
  });

  it("rejects non-latin text, too short codes, edge hyphens and UUIDs", () => {
    expect(normalizeShortCode("游戏剧情")).toBeNull();
    expect(normalizeShortCode("a")).toBeNull();
    expect(normalizeShortCode("-narr")).toBeNull();
    expect(normalizeShortCode("narr-")).toBeNull();
    expect(normalizeShortCode(JOB_A)).toBeNull();
    expect(normalizeShortCode(undefined)).toBeNull();
  });
});

describe("role aliases", () => {
  it("finds a job by short code, then by slug, ignoring case", () => {
    expect(findJobByCode(jobs, "NARR-JR")?.id).toBe(JOB_A);
    expect(findJobByCode(jobs, "backend-engineer")?.id).toBe(JOB_B);
    expect(findJobByCode(jobs, "nope")).toBeUndefined();
    expect(findJobByCode(jobs, "")).toBeUndefined();
  });

  it("prefers a short code over another job's slug", () => {
    const clash: DirectoryJobRef[] = [
      { id: JOB_A, title: "A", slug: "shared", shortCode: null },
      { id: JOB_B, title: "B", slug: "b", shortCode: "shared" },
    ];
    expect(findJobByCode(clash, "shared")?.id).toBe(JOB_B);
  });

  it("turns role=<code> into the job title and leaves the rest alone", () => {
    expect(expandRoleAliases({ role: "narr-jr", days: "14" }, jobs)).toEqual({
      role: "游戏剧情策划实习",
      days: "14",
    });
    expect(expandRoleAliases({ role: ["narr-jr", "growth"] }, jobs)).toEqual({
      role: ["游戏剧情策划实习", "Growth Lead"],
    });
  });

  it("keeps a real title, an unknown value and filters without role", () => {
    expect(expandRoleAliases({ role: "Backend Engineer" }, jobs)).toEqual({ role: "Backend Engineer" });
    expect(expandRoleAliases({ role: "unknown-role" }, jobs)).toEqual({ role: "unknown-role" });
    const noRole = { days: "7" };
    expect(expandRoleAliases(noRole, jobs)).toBe(noRole);
  });

  it("does not replace a title that happens to equal another job's code", () => {
    const tricky: DirectoryJobRef[] = [
      { id: JOB_A, title: "growth", slug: "a", shortCode: null },
      { id: JOB_C, title: "Growth Lead", slug: "g", shortCode: "growth" },
    ];
    expect(expandRoleAliases({ role: "growth" }, tricky)).toEqual({ role: "growth" });
  });
});

describe("buildJobShortUrl", () => {
  it("shortens one job title plus other filters to /c/<code>", () => {
    const url = buildJobShortUrl(
      "https://people.example",
      { role: "游戏剧情策划实习", source: "boss", days: "14" },
      jobs,
    );
    expect(url).toBe("https://people.example/c/narr-jr?source=boss&days=14");
    expect(url!.length).toBeLessThan(60);
  });

  it("returns a bare /c/<code> when only the job is filtered", () => {
    expect(buildJobShortUrl("", { role: "Growth Lead" }, jobs)).toBe("/c/growth");
  });

  it("gives no short link without a unique job that has a code", () => {
    expect(buildJobShortUrl("", { role: "Backend Engineer" }, jobs)).toBeNull();
    expect(buildJobShortUrl("", { role: ["Growth Lead", "Backend Engineer"] }, jobs)).toBeNull();
    expect(buildJobShortUrl("", { days: "7" }, jobs)).toBeNull();
    expect(buildJobShortUrl("", { role: "Growth Lead", list: JOB_A }, jobs)).toBeNull();
    const twins = [...jobs, { id: "44444444-4444-4444-8444-444444444444", title: "Growth Lead", slug: "g2", shortCode: null }];
    expect(buildJobShortUrl("", { role: "Growth Lead" }, twins)).toBeNull();
  });

  it("round-trips: the short link filters exactly like the long link", () => {
    const filters = { role: "游戏剧情策划实习", source: "boss", days: "14", hasResume: "1" };
    const short = buildJobShortUrl("", filters, jobs)!;
    const query = new URL(short, "https://x.test");
    const code = decodeURIComponent(query.pathname.replace("/c/", ""));
    const job = findJobByCode(jobs, code)!;
    const params = new URLSearchParams(query.search);
    params.set("role", job.title);
    const fromShort = directoryOrigin(params);
    const fromLong = directoryOrigin(new URL(buildCandidatesDirectoryUrl("https://x.test", filters)).searchParams);
    expect(fromShort).toEqual(fromLong);
  });
});

describe("saved filter links", () => {
  it("builds /v/<id>", () => {
    expect(buildSavedFilterShortUrl("https://people.example/", "k7m2x9p")).toBe("https://people.example/v/k7m2x9p");
    expect(buildSavedFilterShortUrl("", "k7m2x9p")).toBe("/v/k7m2x9p");
  });

  it("accepts a short id or UUID in ?list= and drops anything else", () => {
    expect(cleanDirectoryFilters({ list: "K7M2X9P" })).toEqual({ list: "k7m2x9p" });
    expect(cleanDirectoryFilters({ list: JOB_A })).toEqual({ list: JOB_A });
    expect(cleanDirectoryFilters({ list: "not a list" })).toEqual({});
    expect(cleanDirectoryFilters({ list: "l0o1i" })).toEqual({});
  });
});

describe("readableFilterTitle", () => {
  it("reads like the example in the request", () => {
    expect(readableFilterTitle({ role: "游戏剧情策划实习", source: "boss", days: "14" })).toBe(
      "游戏剧情策划实习 · BOSS · 近14天",
    );
  });

  it("names jobs by id and lists several titles", () => {
    expect(readableFilterTitle({ jobId: JOB_A, hasResume: "1" }, { jobTitleById: { [JOB_A]: "游戏剧情策划实习" } })).toBe(
      "游戏剧情策划实习 · 有简历",
    );
    expect(readableFilterTitle({ role: ["游戏剧情策划实习", "运营"], stage: "面试" })).toBe(
      "游戏剧情策划实习、运营 · 面试",
    );
  });

  it("falls back to English labels and to 'all candidates'", () => {
    expect(readableFilterTitle({ role: "Backend Engineer", source: "boss", days: "14" })).toBe(
      "Backend Engineer · BOSS · last 14 days",
    );
    expect(readableFilterTitle({})).toBe("All candidates");
    expect(readableFilterTitle({}, { lang: "zh" })).toBe("全部候选人");
  });

  it("describes date ranges and status", () => {
    expect(
      readableFilterTitle({ dept: "内容", appliedAfter: "2026-11-01", appliedBefore: "2026-11-20", status: "active" }),
    ).toBe("内容 · 进行中 · 2026-11-01 ~ 2026-11-20");
  });
});
