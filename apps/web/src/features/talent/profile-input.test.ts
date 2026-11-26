import { describe, expect, it } from "vitest";

import {
  normalizeTalentProfile,
  TalentProfileValidationError,
  talentProfileInputSchema,
} from "./profile-input";
import { splitList, talentFiltersFromQuery } from "./query-params";

const base = {
  tagVersion: "v1",
  engine: "test-engine",
  skills: ["Unity", "unity ", "Lua"],
  roles: ["Game Designer"],
  works: [{ kind: "游戏作品", title: "Puzzle Garden" }],
  evidence: [
    { field: "skills", value: "UNITY", quote: "Built levels in Unity" },
    { field: "skills", value: "Lua", quote: "Scripted quests in Lua" },
    { field: "roles", value: "Game Designer", quote: "Game Designer, 2021-2024" },
    { field: "works", value: "Puzzle Garden", quote: "Shipped Puzzle Garden" },
  ],
  matches: [
    { postingKey: "casual_game", score: 8, evidence: [{ quote: "Shipped Puzzle Garden" }] },
    { postingKey: "drama_writer", score: 2 },
  ],
};

describe("normalizeTalentProfile", () => {
  it("dedupes tags case-insensitively and derives best match and work kinds", () => {
    const profile = normalizeTalentProfile(base, new Date("2026-01-02T03:04:05Z"));
    expect(profile.skills).toEqual(["Unity", "Lua"]);
    expect(profile.workKinds).toEqual(["游戏作品"]);
    expect(profile.bestPostingKey).toBe("casual_game");
    expect(profile.bestScore).toBe(8);
    expect(profile.taggedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("rejects a tag without an evidence quote", () => {
    expect(() =>
      normalizeTalentProfile({ ...base, companies: ["Example Studio"] }),
    ).toThrowError(TalentProfileValidationError);
    try {
      normalizeTalentProfile({ ...base, companies: ["Example Studio"] });
    } catch (error) {
      expect((error as TalentProfileValidationError).issues).toEqual([
        'companies "Example Studio" has no evidence quote',
      ]);
    }
  });

  it("rejects a work without a quote and a strong match without evidence", () => {
    const run = () =>
      normalizeTalentProfile({
        ...base,
        works: [{ kind: "其他", title: "Unquoted Project" }],
        matches: [{ postingKey: "casual_game", score: 7 }],
      });
    expect(run).toThrowError(/Unquoted Project/);
    expect(run).toThrowError(/scores 7 without an evidence quote/);
  });

  it("rejects the same posting twice", () => {
    expect(() =>
      normalizeTalentProfile({
        ...base,
        matches: [
          { postingKey: "casual_game", score: 1 },
          { postingKey: "casual_game", score: 2 },
        ],
      }),
    ).toThrowError(/twice/);
  });

  it("refuses unknown fields such as age", () => {
    expect(talentProfileInputSchema.safeParse({ ...base, age: 30 }).success).toBe(false);
    expect(talentProfileInputSchema.safeParse({ ...base, ageBand: "25-29" }).success).toBe(false);
  });

  it("refuses out-of-range scores and bad posting keys", () => {
    expect(
      talentProfileInputSchema.safeParse({
        ...base,
        matches: [{ postingKey: "casual_game", score: 11 }],
      }).success,
    ).toBe(false);
    expect(
      talentProfileInputSchema.safeParse({
        ...base,
        matches: [{ postingKey: "Casual Game", score: 3 }],
      }).success,
    ).toBe(false);
  });
});

describe("talent query params", () => {
  it("splits ASCII and full-width commas", () => {
    expect(splitList("Unity, Lua，C#")).toEqual(["Unity", "Lua", "C#"]);
    expect(splitList(" , ")).toBeUndefined();
    expect(splitList(undefined)).toBeUndefined();
  });

  it("maps the REST query to service filters", () => {
    expect(
      talentFiltersFromQuery({
        q: "puzzle",
        skills: "Unity,Lua",
        posting: "casual_game",
        minScore: 7,
        contacted: "false",
        includeEvidence: "true",
        sort: "score",
      }),
    ).toMatchObject({
      query: "puzzle",
      skills: ["Unity", "Lua"],
      postingKey: "casual_game",
      minScore: 7,
      contacted: false,
      includeEvidence: true,
      sort: "score",
    });
  });
});
