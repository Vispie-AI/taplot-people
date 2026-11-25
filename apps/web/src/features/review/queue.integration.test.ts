import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { applications, candidateFiles, candidates, db, scorecards } from "@harly/db";

import {
  createAuthorizationFixture,
  type ActorKey,
  type AuthorizationFixture,
} from "@/test-support/authorization-fixture";
import { runPipelineIntegration } from "@/test-support/pipeline-fixture";

const ctx = vi.hoisted(() => ({ workspaceId: "", userId: "", roleKey: "owner" }));

vi.mock("@/features/workspaces/context", () => ({
  getWorkspaceContext: vi.fn(async () => ({
    organization: { id: ctx.workspaceId, name: "Auth", slug: "auth" },
    user: { id: ctx.userId, email: "auth@example.test", name: "Auth User", image: null },
    membership: { id: "member", role: ctx.roleKey },
    role: ctx.roleKey,
    roleKey: ctx.roleKey,
    session: {},
  })),
  getWorkspaceContextOrNull: vi.fn(async () => null),
}));

import { resolveSearchActor } from "@/features/search/workspace-search";

import { getNeedsScheduling, getReviewQueue } from "./queue";

describe.skipIf(!runPipelineIntegration)("review queue (database)", () => {
  let fx: AuthorizationFixture;
  let interviewCandidate: string;
  let staleCandidate: string;
  let staleApplication: string;

  async function actor(key: ActorKey) {
    ctx.workspaceId = fx.workspaceId;
    ctx.userId = fx.users[key];
    ctx.roleKey = fx.roleKeys[key];
    // A fresh object per call: the loader is cached per actor instance.
    return resolveSearchActor();
  }

  beforeAll(async () => {
    fx = await createAuthorizationFixture();
    // An application in an interview-kind stage with no interview scheduled.
    const [candidate] = await db
      .insert(candidates)
      .values({
        workspaceId: fx.workspaceId,
        firstName: "Queue",
        lastName: "Interview",
        email: "queue-interview@example.test",
      })
      .returning({ id: candidates.id });
    interviewCandidate = candidate!.id;
    await db.insert(applications).values({
      workspaceId: fx.workspaceId,
      candidateId: interviewCandidate,
      jobId: fx.jobA,
      currentStageId: fx.stagesA.interview!.id,
    });
    // A resume review that has waited 200 days with no other activity.
    const [old] = await db
      .insert(candidates)
      .values({
        workspaceId: fx.workspaceId,
        firstName: "Queue",
        lastName: "Stale",
        email: "queue-stale@example.test",
      })
      .returning({ id: candidates.id });
    staleCandidate = old!.id;
    const [oldApp] = await db
      .insert(applications)
      .values({
        workspaceId: fx.workspaceId,
        candidateId: staleCandidate,
        jobId: fx.jobA,
        currentStageId: fx.stagesA.screening!.id,
        appliedAt: new Date(Date.now() - 200 * 86_400_000),
      })
      .returning({ id: applications.id });
    staleApplication = oldApp!.id;
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("returns nothing without candidates:view", async () => {
    const none = await actor("none");
    expect(await getReviewQueue(none)).toEqual({ total: 0, waitingOverWeek: 0, staleTotal: 0, items: [] });
    expect(await getNeedsScheduling(none)).toEqual({ total: 0, items: [] });
  });

  it("lists screening applications inside the caller's scope only", async () => {
    const scoped = await getReviewQueue(await actor("scoped"));
    const ids = scoped.items.map((item) => item.candidateId);
    expect(ids).toContain(fx.candidateA);
    expect(ids).not.toContain(fx.candidateB);
    expect(scoped.total).toBe(scoped.items.length);
    expect(scoped.items.every((item) => item.stageKind === "screening" || item.stageKind === "interview")).toBe(true);

    const full = await getReviewQueue(await actor("full"));
    expect(full.items.map((item) => item.candidateId)).toEqual(
      expect.arrayContaining([fx.candidateA, fx.candidateB]),
    );
  });

  it("keeps an interview-stage application out of the queue until an interview exists", async () => {
    const full = await actor("full");
    const queue = await getReviewQueue(full);
    expect(queue.items.map((item) => item.candidateId)).not.toContain(interviewCandidate);
    const scheduling = await getNeedsScheduling(full);
    expect(scheduling.items.map((item) => item.candidateId)).toContain(interviewCandidate);
  });

  it("applies the limit to items but not to the total", async () => {
    const full = await actor("full");
    const all = await getReviewQueue(full);
    const limited = await getReviewQueue(full, { limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.total).toBe(all.total);
    expect(limited.items[0]).toEqual(all.items[0]);
  });

  it("drops an application once the caller submitted a scorecard for its current stage", async () => {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.candidateId, fx.candidateA));
    const before = await getReviewQueue(await actor("full"));
    expect(before.items.map((item) => item.applicationId)).toContain(app!.id);

    await db.insert(scorecards).values({
      workspaceId: fx.workspaceId,
      candidateId: fx.candidateA,
      applicationId: app!.id,
      stageId: fx.stagesA.screening!.id,
      stageName: fx.stagesA.screening!.name,
      authorId: fx.users.full,
      rating: "strong",
    });
    const after = await getReviewQueue(await actor("full"));
    expect(after.items.map((item) => item.applicationId)).not.toContain(app!.id);
    // Someone else's scorecard does not clear it for them.
    const other = await getReviewQueue(await actor("scoped"));
    expect(other.items.map((item) => item.applicationId)).toContain(app!.id);
  });

  it("leaves resume reviews with no activity for over 90 days out of the default queue and the total", async () => {
    const full = await actor("full");
    const queue = await getReviewQueue(full);
    expect(queue.items.map((item) => item.applicationId)).not.toContain(staleApplication);
    expect(queue.total).toBe(queue.items.length);
    expect(queue.staleTotal).toBeGreaterThanOrEqual(1);

    // Reversible: the switch lists it again, flagged, without changing the total.
    const withStale = await getReviewQueue(await actor("full"), { includeStale: true });
    const staleItem = withStale.items.find((item) => item.applicationId === staleApplication);
    expect(staleItem?.stale).toBe(true);
    expect(staleItem?.ageDays).toBeGreaterThan(90);
    expect(withStale.total).toBe(queue.total);
    expect(withStale.items).toHaveLength(queue.total + queue.staleTotal);
  });

  it("puts a stale resume review back in the queue after a new resume arrives", async () => {
    await db.insert(candidateFiles).values({
      workspaceId: fx.workspaceId,
      candidateId: staleCandidate,
      fileName: "new-resume.pdf",
      fileUrl: "resumes/new-resume.pdf",
    });
    const queue = await getReviewQueue(await actor("full"));
    expect(queue.items.map((item) => item.applicationId)).toContain(staleApplication);
  });
});
