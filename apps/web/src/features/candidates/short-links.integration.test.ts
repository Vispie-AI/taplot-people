import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { applications, candidateLists, db, jobs } from "@harly/db";

import {
  createAuthorizationFixture,
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

// Next's redirect()/notFound() throw; surface them so the test can read the target.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: url });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true });
  },
}));

import { GET as openJobShortLink } from "@/app/c/[code]/route";
import { GET as openSavedFilter } from "@/app/v/[shortId]/route";
import { listCandidateDirectory } from "./data";
import {
  expandDirectoryRoleAliases,
  listDirectoryJobRefs,
} from "./job-refs";
import { createCandidateList, ensureCandidateListShortId, getCandidateList } from "./lists";
import { directoryOrigin, buildCandidatesDirectoryUrl } from "./origin";
import { originFiltersToDirectoryFilters } from "./directory-query";
import { saveDirectoryFilterAction } from "./short-link-actions";
import { buildJobShortUrl } from "./short-links";

const ROLE = "游戏剧情策划实习";
const ORIGIN = "https://people.example.test";

describe.skipIf(!runPipelineIntegration)("short candidate links (database)", () => {
  let fx: AuthorizationFixture;

  /** Follow a short link handler to the long directory URL it redirects to. */
  async function redirectTarget(
    handler: (req: never, ctx: never) => Promise<unknown>,
    url: string,
    params: Record<string, string>,
  ): Promise<string> {
    const { NextRequest } = await import("next/server");
    try {
      await handler(new NextRequest(url) as never, { params: Promise.resolve(params) } as never);
    } catch (error) {
      const target = (error as { redirectTo?: string }).redirectTo;
      if (target) return target;
      throw error;
    }
    throw new Error("expected a redirect");
  }

  /** The people (ids) a /dashboard/candidates URL lists, as the page resolves it. */
  async function peopleAt(longUrl: string): Promise<string[]> {
    const url = new URL(longUrl, ORIGIN);
    const origin = directoryOrigin(url.searchParams);
    const filters = await expandDirectoryRoleAliases(origin.kind === "candidates" ? origin.filters : {});
    const page = await listCandidateDirectory({ ...originFiltersToDirectoryFilters(filters), pageSize: 100 });
    return page.rows.map((row) => row.id).sort();
  }

  beforeAll(async () => {
    fx = await createAuthorizationFixture();
    ctx.workspaceId = fx.workspaceId;
    ctx.userId = fx.users.full;
    ctx.roleKey = fx.roleKeys.full;
    await db
      .update(jobs)
      .set({ title: ROLE, shortCode: "Narr-JR", slug: "game-narrative-intern" })
      .where(eq(jobs.id, fx.jobA));
    await db.update(jobs).set({ title: "Backend Engineer" }).where(eq(jobs.id, fx.jobB));
    await db
      .update(applications)
      .set({ source: "boss", appliedAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(and(eq(applications.id, fx.applicationAB.onA)));
    await db
      .update(applications)
      .set({ source: "career_page", appliedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(and(eq(applications.jobId, fx.jobA), eq(applications.candidateId, fx.candidateA)));
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("stores the short code and refuses a clash with another job in the workspace", async () => {
    const refs = await listDirectoryJobRefs();
    expect(refs.find((job) => job.id === fx.jobA)?.shortCode).toBe("Narr-JR");
    await expect(
      db.update(jobs).set({ shortCode: "narr-jr" }).where(eq(jobs.id, fx.jobB)),
    ).rejects.toThrow();
  });

  it("/c/<code> lists the same people as the long link, with or without extra filters", async () => {
    const longs = [
      buildCandidatesDirectoryUrl("", { role: ROLE }),
      buildCandidatesDirectoryUrl("", { role: ROLE, source: "boss", days: "14" }),
      buildCandidatesDirectoryUrl("", { role: ROLE, days: "7", hasResume: "1" }),
    ];
    const shorts = [
      "/c/narr-jr",
      "/c/narr-jr?source=boss&days=14",
      "/c/narr-jr?days=7&hasResume=1",
    ];
    for (const [i, short] of shorts.entries()) {
      const target = await redirectTarget(openJobShortLink, `${ORIGIN}${short}`, { code: "narr-jr" });
      expect(target).toMatch(/^\/dashboard\/candidates\?/);
      expect(await peopleAt(target)).toEqual(await peopleAt(longs[i]!));
    }
    // The filters really narrow things, so the equality above is not trivial.
    const all = await peopleAt(longs[0]!);
    const boss = await peopleAt(longs[1]!);
    expect(all.length).toBeGreaterThan(boss.length);
    expect(boss).toEqual([fx.candidateAB]);
  });

  it("opens a job by its slug too, and 404s on an unknown code", async () => {
    const target = await redirectTarget(openJobShortLink, `${ORIGIN}/c/game-narrative-intern`, {
      code: "game-narrative-intern",
    });
    expect(await peopleAt(target)).toEqual(await peopleAt(buildCandidatesDirectoryUrl("", { role: ROLE })));
    await expect(
      redirectTarget(openJobShortLink, `${ORIGIN}/c/nope`, { code: "nope" }),
    ).rejects.toMatchObject({ notFound: true });
  });

  it("accepts the short code in ?role= on the directory itself", async () => {
    expect(await peopleAt("/dashboard/candidates?role=narr-jr&source=boss")).toEqual(
      await peopleAt(buildCandidatesDirectoryUrl("", { role: ROLE, source: "boss" })),
    );
  });

  it("builds a /c/ link from the long filters that opens to the same people", async () => {
    const refs = await listDirectoryJobRefs();
    const filters = { role: ROLE, source: "boss", days: "14" };
    const short = buildJobShortUrl("", filters, refs)!;
    expect(short).toBe("/c/Narr-JR?source=boss&days=14");
    const target = await redirectTarget(openJobShortLink, `${ORIGIN}${short}`, { code: "Narr-JR" });
    expect(await peopleAt(target)).toEqual(await peopleAt(buildCandidatesDirectoryUrl("", filters)));
  });

  it("saves a filter once, names it readably, and /v/<id> lists the same people", async () => {
    const filters = { role: ROLE, source: "boss", days: "14" };
    const saved = await saveDirectoryFilterAction(filters);
    if (!saved.success) throw new Error(saved.error);
    expect(saved.created).toBe(true);
    expect(saved.title).toBe(`${ROLE} · BOSS · 近14天`);
    expect(saved.shortId).toHaveLength(7);

    // Same filters again (even via the short code) reuse the list: a stable link.
    const again = await saveDirectoryFilterAction({ role: "narr-jr", source: "boss", days: "14" });
    expect(again).toMatchObject({ success: true, shortId: saved.shortId, created: false });

    const target = await redirectTarget(openSavedFilter, `${ORIGIN}/v/${saved.shortId}`, { shortId: saved.shortId });
    expect(target).toBe(`/dashboard/candidates?list=${saved.shortId}`);
    expect(await peopleAt(target)).toEqual(await peopleAt(buildCandidatesDirectoryUrl("", filters)));

    // The saved list also resolves through its UUID (the old `?list=<uuid>` links).
    const record = await getCandidateList(fx.workspaceId, saved.shortId);
    expect(record?.filterSpec).toMatchObject({ role: ROLE, source: "boss", days: "14" });
    expect(await peopleAt(`/dashboard/candidates?list=${record!.id}`)).toEqual(
      await peopleAt(buildCandidatesDirectoryUrl("", filters)),
    );
  });

  it("gives lists saved before short ids existed a short id on demand, once", async () => {
    const legacy = await createCandidateList({
      workspaceId: fx.workspaceId,
      title: "legacy",
      mode: "filter",
      filterSpec: { source: "career_page" },
    });
    await db.update(candidateLists).set({ shortId: null }).where(eq(candidateLists.id, legacy.id));
    const bare = (await getCandidateList(fx.workspaceId, legacy.id))!;
    expect(bare.shortId).toBeNull();
    const first = await ensureCandidateListShortId(bare);
    const second = await ensureCandidateListShortId(bare);
    expect(first.shortId).toMatch(/^[2-9a-hjkmnp-z]{7}$/);
    expect(second.shortId).toBe(first.shortId);
    expect(await peopleAt(`/dashboard/candidates?list=${legacy.id}`)).toEqual(
      await peopleAt(`/dashboard/candidates?list=${first.shortId}`),
    );
  });

  it("keeps old long links (role=<title>, jobId, list=<uuid>) working unchanged", async () => {
    const byTitle = await peopleAt(`/dashboard/candidates?role=${encodeURIComponent(ROLE)}&source=boss&days=14`);
    expect(byTitle).toEqual([fx.candidateAB]);
    const byJobId = await peopleAt(`/dashboard/candidates?jobId=${fx.jobA}`);
    expect(byJobId).toEqual(expect.arrayContaining([fx.candidateA, fx.candidateAB]));
    expect(byJobId).not.toContain(fx.candidateB);
  });

  it("does not open another workspace's saved filter", async () => {
    const saved = await saveDirectoryFilterAction({ source: "boss" });
    if (!saved.success) throw new Error(saved.error);
    const previous = ctx.workspaceId;
    ctx.workspaceId = fx.otherWorkspaceCandidate.workspaceId;
    try {
      // No role in that workspace: sent back to the dashboard, never to the list.
      const outcome = await redirectTarget(openSavedFilter, `${ORIGIN}/v/${saved.shortId}`, {
        shortId: saved.shortId,
      }).catch((error: { notFound?: boolean }) => (error.notFound ? "not-found" : "error"));
      expect(outcome).not.toContain("list=");
    } finally {
      ctx.workspaceId = previous;
    }
  });
});
