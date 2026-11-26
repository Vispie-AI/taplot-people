import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit-log", () => audit);

import { eq } from "drizzle-orm";

import {
  bossResumeImports,
  candidateAiScreenings,
  candidateFiles,
  candidates,
  db,
  jobs,
  organization,
  user,
} from "@harly/db";

import { listAiScreenings, upsertAiScreenings } from "./service";

/**
 * Needs a migrated throwaway Postgres (same flag as the talent suite):
 *   RUN_TALENT_INTEGRATION=1 DATABASE_URL=postgresql://... pnpm --filter web exec vitest run src/features/ai-screenings/service.integration.test.ts
 */
const run = process.env.RUN_TALENT_INTEGRATION === "1";
const origin = "https://people.example.test";

describe.skipIf(!run)("ai screenings (database)", () => {
  const tag = randomUUID().slice(0, 8);
  const workspaceId = `ws-screen-${tag}`;
  const otherWorkspaceId = `ws-screen-other-${tag}`;
  const userId = `screen-user-${tag}`;
  const ids: Record<string, string> = {};
  const viewer = { workspaceId, appOrigin: origin };
  const auditCtx = { keyId: "key_test", actorId: userId };

  async function candidate(name: string, workspace = workspaceId) {
    const [row] = await db
      .insert(candidates)
      .values({ workspaceId: workspace, firstName: name, lastName: "Example", email: `${name.toLowerCase()}-${tag}@example.test` })
      .returning({ id: candidates.id });
    return row!.id;
  }

  beforeAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
    }
    await db.insert(user).values({
      id: userId,
      name: "Screen Test",
      email: `screen-${tag}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [job] = await db
      .insert(jobs)
      .values({
        workspaceId,
        title: "Narrative designer",
        slug: "lark-recjobaaa",
        employmentType: "full_time",
        workplaceType: "remote",
        description: "Synthetic job",
        createdById: userId,
      })
      .returning({ id: jobs.id });
    ids.job = job!.id;
    ids.boss = await candidate("Boss");
    ids.direct = await candidate("Direct");
    ids.foreign = await candidate("Foreign", otherWorkspaceId);
    const [file] = await db
      .insert(candidateFiles)
      .values({
        workspaceId,
        candidateId: ids.boss!,
        fileName: "resume.pdf",
        fileUrl: `private://test/${tag}.pdf`,
        fileSize: 10,
        fileType: "application/pdf",
      })
      .returning({ id: candidateFiles.id });
    await db.insert(bossResumeImports).values({
      workspaceId,
      sourceRecordId: "recBOSS1",
      contentHash: "a".repeat(64),
      candidateId: ids.boss!,
      fileId: file!.id,
    });
  });

  afterAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.delete(organization).where(eq(organization.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  const base = { sourceJobId: "recJOBAAA", verdict: "strong" as const, criteria: [], model: "claude-opus-5-5" };

  it("resolves a BOSS source record, links the job and reads it back", async () => {
    const result = await upsertAiScreenings({
      workspaceId,
      audit: auditCtx,
      items: [
        { ...base, sourceRecordId: "recBOSS1", reason: "Shipped two dramas", screenedAt: "2026-11-20T01:00:00Z", criteria: [{ label: "Narrative", result: "yes", quote: "Wrote 12 episodes" }] },
        { ...base, candidateId: ids.direct!, verdict: "maybe", reason: "Thin evidence", screenedAt: "2026-11-21T01:00:00Z" },
        { ...base, sourceRecordId: "recNOPE", screenedAt: "2026-11-21T01:00:00Z" },
        { ...base, candidateId: ids.foreign!, screenedAt: "2026-11-21T01:00:00Z" },
      ],
    });
    expect(result).toEqual({
      written: 2,
      skippedOlder: 0,
      unresolved: [
        { index: 2, reason: "source_record_unknown" },
        { index: 3, reason: "candidate_not_found" },
      ],
    });
    const read = await listAiScreenings(viewer, { candidateId: ids.boss! });
    expect(read.total).toBe(1);
    expect(read.screenings[0]).toMatchObject({
      candidateId: ids.boss,
      url: `${origin}/dashboard/candidates/${ids.boss}`,
      jobId: ids.job,
      jobTitle: "Narrative designer",
      verdict: "strong",
      reason: "Shipped two dramas",
      model: "claude-opus-5-5",
      sourceRecordId: "recBOSS1",
      screenedAt: "2026-11-20T01:00:00.000Z",
      criteria: [{ label: "Narrative", result: "yes", quote: "Wrote 12 episodes" }],
    });
  });

  it("is idempotent, lets a newer screen replace and ignores an older one", async () => {
    const again = await upsertAiScreenings({
      workspaceId,
      audit: auditCtx,
      items: [{ ...base, sourceRecordId: "recBOSS1", reason: "Shipped two dramas", screenedAt: "2026-11-20T01:00:00Z" }],
    });
    expect(again.written).toBe(1);
    const newer = await upsertAiScreenings({
      workspaceId,
      audit: auditCtx,
      items: [{ ...base, sourceRecordId: "recBOSS1", verdict: "no", reason: "Second look", screenedAt: "2026-11-22T01:00:00Z" }],
    });
    expect(newer.written).toBe(1);
    const older = await upsertAiScreenings({
      workspaceId,
      audit: auditCtx,
      items: [{ ...base, sourceRecordId: "recBOSS1", verdict: "strong", reason: "Stale", screenedAt: "2026-11-19T01:00:00Z" }],
    });
    expect(older).toEqual({ written: 0, skippedOlder: 1, unresolved: [] });
    const read = await listAiScreenings(viewer, { candidateId: ids.boss! });
    expect(read.total).toBe(1);
    expect(read.screenings[0]).toMatchObject({ verdict: "no", reason: "Second look" });
  });

  it("filters by period and verdict, counts per verdict and never crosses workspaces", async () => {
    const all = await listAiScreenings(viewer);
    expect(all.byVerdict).toEqual({ strong: 0, maybe: 1, no: 1 });
    expect(all.total).toBe(2);
    expect(all.screenings.map((s) => s.candidateId)).toEqual([ids.boss, ids.direct]);

    const maybe = await listAiScreenings(viewer, { verdict: "maybe" });
    expect(maybe.screenings.map((s) => s.candidateId)).toEqual([ids.direct]);

    const window = await listAiScreenings(viewer, {
      since: new Date("2026-11-21T00:00:00Z"),
      until: new Date("2026-11-22T00:00:00Z"),
    });
    expect(window.screenings.map((s) => s.candidateId)).toEqual([ids.direct]);

    const other = await listAiScreenings({ workspaceId: otherWorkspaceId, appOrigin: origin });
    expect(other.total).toBe(0);
    const rows = await db.select().from(candidateAiScreenings).where(eq(candidateAiScreenings.workspaceId, otherWorkspaceId));
    expect(rows).toHaveLength(0);
  });

  it("records one audit row per write request, with counts only", async () => {
    const calls = audit.logAuditEvent.mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((c) => c.action === "candidate.ai_screenings.upserted")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("Shipped two dramas");
  });
});
