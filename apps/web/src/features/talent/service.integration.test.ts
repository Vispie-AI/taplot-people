import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit-log", () => audit);

import { and, eq, sql } from "drizzle-orm";

import {
  applications,
  candidateTalentMatches,
  candidateTalentProfiles,
  candidates,
  db,
  jobStages,
  jobs,
  organization,
  user,
} from "@harly/db";

import { normalizeTalentProfile } from "./profile-input";
import {
  deleteTalentProfile,
  getTalentProfile,
  searchTalent,
  talentStats,
  upsertTalentProfile,
} from "./service";
import { listTaggingCandidates, loadTaggingInput } from "./tagging-input";

/**
 * Needs a migrated throwaway Postgres:
 *   RUN_TALENT_INTEGRATION=1 DATABASE_URL=postgresql://... pnpm --filter web exec vitest run src/features/talent/service.integration.test.ts
 */
const run = process.env.RUN_TALENT_INTEGRATION === "1";
const origin = "https://people.example.test";

describe.skipIf(!run)("talent profiles (database)", () => {
  const tag = randomUUID().slice(0, 8);
  const workspaceId = `ws-talent-${tag}`;
  const otherWorkspaceId = `ws-talent-other-${tag}`;
  const userId = `talent-user-${tag}`;
  const ids: Record<string, string> = {};
  const viewer = { workspaceId, appOrigin: origin };

  async function candidate(name: string, workspace = workspaceId) {
    const [row] = await db
      .insert(candidates)
      .values({
        workspaceId: workspace,
        firstName: name,
        lastName: "Example",
        email: `${name.toLowerCase()}-${tag}@example.test`,
        headline: `${name} headline`,
      })
      .returning({ id: candidates.id });
    return row!.id;
  }

  function profile(skill: string, score: number, extra: Record<string, unknown> = {}) {
    return normalizeTalentProfile({
      tagVersion: "v1",
      engine: "test",
      city: "Shenzhen",
      experienceYears: 5,
      education: "本科",
      skills: [skill],
      keyCompanies: ["Example Games"],
      sourceChannels: ["BOSS"],
      works: [{ kind: "游戏作品", title: "Puzzle Garden" }],
      evidence: [
        { field: "skills", value: skill, quote: `Worked with ${skill}` },
        { field: "keyCompanies", value: "Example Games", quote: "Example Games, 2020-2024" },
        { field: "works", value: "Puzzle Garden", quote: "Shipped Puzzle Garden" },
      ],
      matches: [
        {
          postingKey: "casual_game",
          postingLabel: "Casual game designer",
          score,
          evidence: score >= 5 ? [{ quote: "Shipped Puzzle Garden" }] : [],
        },
      ],
      lastActiveAt: "2026-03-10T00:00:00Z",
      ...extra,
    });
  }

  beforeAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
    }
    await db.insert(user).values({
      id: userId,
      name: "Talent Test",
      email: `talent-${tag}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [job] = await db
      .insert(jobs)
      .values({
        workspaceId,
        title: "Casual game designer",
        slug: `talent-${tag}`,
        employmentType: "full_time",
        workplaceType: "remote",
        description: "Synthetic job",
        createdById: userId,
      })
      .returning({ id: jobs.id });
    const [interviewStage] = await db
      .insert(jobStages)
      .values({ workspaceId, jobId: job!.id, name: "Panel", order: 1, kind: "interview" })
      .returning({ id: jobStages.id });

    ids.fresh = await candidate("Fresh");
    ids.engaged = await candidate("Engaged");
    ids.low = await candidate("Low");
    ids.untagged = await candidate("Untagged");
    ids.foreign = await candidate("Foreign", otherWorkspaceId);

    await db.insert(applications).values({
      workspaceId,
      candidateId: ids.engaged,
      jobId: job!.id,
      currentStageId: interviewStage!.id,
    });

    const audit = { keyId: "key_test", actorId: userId };
    await upsertTalentProfile({ workspaceId, candidateId: ids.fresh!, profile: profile("Unity", 9), audit });
    await upsertTalentProfile({ workspaceId, candidateId: ids.engaged!, profile: profile("Unity", 8), audit });
    await upsertTalentProfile({
      workspaceId,
      candidateId: ids.low!,
      profile: profile("Lua", 3, { lastActiveAt: "2025-01-01T00:00:00Z" }),
      audit,
    });
    await upsertTalentProfile({
      workspaceId: otherWorkspaceId,
      candidateId: ids.foreign!,
      profile: profile("Unity", 10),
      audit,
    });
  });

  afterAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.delete(organization).where(eq(organization.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  it("writes an audit event per write and refuses another workspace's candidate", async () => {
    expect(audit.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        action: "candidate.talent_profile.created",
        resourceId: ids.fresh,
      }),
    );
    await expect(
      upsertTalentProfile({
        workspaceId,
        candidateId: ids.foreign!,
        profile: profile("Unity", 9),
        audit: {},
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("lists high matches nobody has contacted, sorted by posting score, with links", async () => {
    const result = await searchTalent(viewer, {
      postingKey: "casual_game",
      minScore: 7,
      contacted: false,
    });
    expect(result.total).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      candidateId: ids.fresh,
      contacted: false,
      url: `${origin}/dashboard/candidates/${ids.fresh}`,
      best: { postingKey: "casual_game", score: 9 },
    });

    const all = await searchTalent(viewer, { postingKey: "casual_game" });
    expect(all.candidates.map((row) => row.candidateId)).toEqual([ids.fresh, ids.engaged, ids.low]);
    expect(all.candidates.find((row) => row.candidateId === ids.engaged)?.contacted).toBe(true);
  });

  it("filters by keyword, exact skill, company substring and time range", async () => {
    const keyword = await searchTalent(viewer, { query: "puzzle garden" });
    expect(keyword.total).toBe(3);
    const skill = await searchTalent(viewer, { skills: ["lua"] });
    expect(skill.candidates.map((row) => row.candidateId)).toEqual([ids.low]);
    const company = await searchTalent(viewer, { keyCompanies: ["example"] });
    expect(company.total).toBe(3);
    const recent = await searchTalent(viewer, { lastActiveAfter: "2026-01-01" });
    expect(recent.total).toBe(2);
    const none = await searchTalent(viewer, { skills: ["Unity"], lastActiveBefore: "2025-06-01" });
    expect(none.total).toBe(0);
  });

  it("honours the caller's candidate scope", async () => {
    const scoped = await searchTalent(
      { ...viewer, visibleCandidate: sql`${candidates.id} = ${ids.low}::uuid` },
      {},
    );
    expect(scoped.candidates.map((row) => row.candidateId)).toEqual([ids.low]);
    expect(
      await getTalentProfile({ ...viewer, visibleCandidate: sql`false` }, ids.fresh!),
    ).toBeNull();
  });

  it("returns evidence on the profile and replaces matches on rewrite", async () => {
    const before = await getTalentProfile(viewer, ids.low!);
    expect(before?.evidence?.length).toBe(3);
    await upsertTalentProfile({
      workspaceId,
      candidateId: ids.low!,
      profile: profile("Lua", 6, {
        matches: [
          { postingKey: "drama_writer", score: 6, evidence: [{ quote: "Wrote scripts" }] },
        ],
      }),
      audit: {},
    });
    const after = await getTalentProfile(viewer, ids.low!);
    expect(after?.matches.map((match) => match.postingKey)).toEqual(["drama_writer"]);
    expect(after?.best).toEqual({ postingKey: "drama_writer", score: 6 });
    const rows = await db
      .select()
      .from(candidateTalentProfiles)
      .where(and(eq(candidateTalentProfiles.workspaceId, workspaceId), eq(candidateTalentProfiles.candidateId, ids.low!)));
    expect(rows).toHaveLength(1);
  });

  it("summarises the pool per posting, source and key company", async () => {
    const stats = await talentStats(viewer, { weeks: 4 });
    expect(stats.candidates).toBe(4);
    expect(stats.profiled).toBe(3);
    const casual = stats.postings.find((row) => row.postingKey === "casual_game");
    expect(casual).toMatchObject({ scored: 2, atLeast7: 2, atLeast7NotContacted: 1 });
    expect(stats.sourceChannels).toEqual([{ channel: "BOSS", candidates: 3 }]);
    expect(stats.keyCompanies[0]).toMatchObject({ company: "Example Games", candidates: 3 });
    expect(stats.weekly.reduce((sum, row) => sum + row.newCandidates, 0)).toBe(4);
  });

  it("serves tagging input with a stable hash and pages candidates to tag", async () => {
    const first = await loadTaggingInput({ workspaceId, candidateId: ids.engaged!, maxChars: 1000 });
    expect(first).toMatchObject({ candidateId: ids.engaged, headline: "Engaged headline", resume: null });
    expect(first.applications).toHaveLength(1);
    const again = await loadTaggingInput({ workspaceId, candidateId: ids.engaged!, maxChars: 1000 });
    expect(again.inputHash).toBe(first.inputHash);
    await expect(
      loadTaggingInput({ workspaceId, candidateId: ids.foreign!, maxChars: 1000 }),
    ).rejects.toThrow(/not found/i);

    const page1 = await listTaggingCandidates({ workspaceId, limit: 2 });
    expect(page1.ids).toHaveLength(2);
    const page2 = await listTaggingCandidates({ workspaceId, limit: 2, after: page1.next! });
    expect([...page1.ids, ...page2.ids].sort()).toEqual(
      [ids.fresh, ids.engaged, ids.low, ids.untagged].sort(),
    );
    const untagged = await listTaggingCandidates({ workspaceId, limit: 10, untaggedOnly: true });
    expect(untagged.ids).toContain(ids.untagged);
    expect(untagged.ids).not.toContain(ids.fresh);
  });

  it("deletes a profile and its matches", async () => {
    expect(await deleteTalentProfile({ workspaceId, candidateId: ids.engaged!, audit: {} })).toBe(true);
    expect(await deleteTalentProfile({ workspaceId, candidateId: ids.engaged!, audit: {} })).toBe(false);
    const matches = await db
      .select()
      .from(candidateTalentMatches)
      .where(eq(candidateTalentMatches.candidateId, ids.engaged!));
    expect(matches).toHaveLength(0);
  });
});
