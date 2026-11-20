import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { decodeCursor, paginate } from "@harly/api";
import { candidates, db, organization } from "@harly/db";

vi.mock("server-only", () => ({}));
vi.mock("@/server/events/emit", () => ({
  persistDomainEvent: vi.fn(),
  publishPersistedDomainEvents: vi.fn(),
}));
vi.mock("@/server/webhooks/emit", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAuditEvent: vi.fn() }));

import { listCandidatesForApi } from "./service";

const integration =
  process.env.RUN_CANDIDATE_PAGINATION_INTEGRATION === "1"
    ? describe
    : describe.skip;

const workspaceId = `cand-pagination-${randomUUID()}`;
const TOTAL = 240;

/** Walk the list endpoint's pagination exactly like the route handler does. */
async function walk(limit: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const rows = await listCandidatesForApi({
      workspaceId,
      cursor: decodeCursor(cursor),
      limit,
    });
    const { items, meta } = paginate(rows, limit, (row) => ({
      createdAt: row.createdAtCursor,
      id: row.id,
    }));
    ids.push(...items.map((item) => item.id));
    if (!meta.hasMore) return ids;
    cursor = meta.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

integration("candidate list pagination with PostgreSQL", () => {
  const expected: string[] = [];

  beforeAll(async () => {
    await db.insert(organization).values({
      id: workspaceId,
      name: "Synthetic workspace",
      slug: workspaceId,
      createdAt: new Date(),
    });
    // Bursts of rows inside one millisecond but with distinct microseconds
    // (what a bulk import produces), plus a few rows sharing an exact timestamp.
    for (let i = 0; i < TOTAL; i++) {
      const burst = Math.floor(i / 8);
      const micro = String((i % 8) * 100 + 11).padStart(6, "0");
      const stamp =
        i % 40 === 39
          ? "2026-01-01T00:00:00.500000Z"
          : `2026-01-01T00:${String(burst % 60).padStart(2, "0")}:${String(Math.floor(burst / 60)).padStart(2, "0")}.${String(burst % 10).padStart(1, "0")}${micro.slice(1)}Z`;
      const [row] = await db
        .insert(candidates)
        .values({
          workspaceId,
          firstName: "Synthetic",
          lastName: `Person ${i}`,
          email: `person-${i}-${workspaceId}@example.test`,
          createdAt: sql`${stamp}::timestamptz` as unknown as Date,
        })
        .returning({ id: candidates.id });
      expected.push(row!.id);
    }
  });

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, workspaceId));
  });

  it("returns every candidate exactly once, identically on repeated walks", async () => {
    for (const limit of [1, 7, 25, 100]) {
      const runs = [await walk(limit), await walk(limit), await walk(limit)];
      for (const ids of runs) {
        expect(ids).toHaveLength(TOTAL);
        expect(new Set(ids).size).toBe(TOTAL);
        expect(new Set(ids)).toEqual(new Set(expected));
      }
      expect(runs[1]).toEqual(runs[0]);
      expect(runs[2]).toEqual(runs[0]);
    }
  });

  it("still accepts cursors issued with millisecond precision", async () => {
    const rows = await listCandidatesForApi({
      workspaceId,
      cursor: { createdAt: "2026-01-01T00:00:00.500Z", id: randomUUID() },
      limit: 5,
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects a malformed cursor instead of failing in SQL", async () => {
    await expect(
      listCandidatesForApi({
        workspaceId,
        cursor: { createdAt: "not-a-date", id: "x" },
        limit: 5,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
