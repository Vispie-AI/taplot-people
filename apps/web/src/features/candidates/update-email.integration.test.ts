import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { candidates, db, organization } from "@harly/db";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  publish: vi.fn(),
  webhook: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/events/emit", () => ({
  persistDomainEvent: mocks.persist,
  publishPersistedDomainEvents: mocks.publish,
}));
vi.mock("@/server/webhooks/emit", () => ({ emitWebhookEvent: mocks.webhook }));
vi.mock("@/lib/audit-log", () => ({ logAuditEvent: mocks.audit }));

import { updateCandidateForApi } from "./service";

const integration =
  process.env.RUN_CANDIDATE_PAGINATION_INTEGRATION === "1" ||
  process.env.RUN_CANDIDATE_EMAIL_UPDATE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const workspaceId = `cand-email-${randomUUID()}`;
const placeholder = "boss-0123456789abcdef01234567@example.invalid";

async function seed(email: string, name = "Synthetic") {
  const [row] = await db
    .insert(candidates)
    .values({ workspaceId, firstName: name, lastName: "Person", email })
    .returning();
  return row!;
}
async function read(id: string) {
  const [row] = await db.select().from(candidates).where(eq(candidates.id, id));
  return row!;
}
function update(
  candidateId: string,
  values: Parameters<typeof updateCandidateForApi>[0]["values"],
) {
  return updateCandidateForApi({ workspaceId, candidateId, values, actorKeyId: "key-1" });
}

integration("PATCH candidate email with PostgreSQL", () => {
  beforeAll(async () => {
    await db.insert(organization).values({
      id: workspaceId,
      name: "Synthetic workspace",
      slug: workspaceId,
      createdAt: new Date(),
    });
  });
  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, workspaceId));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persist.mockResolvedValue({ eventId: randomUUID() });
  });

  it("persists a new email and reads it back, emitting one event with the change", async () => {
    const row = await seed(placeholder);
    const updated = await update(row.id, { email: " Real.Person@Example.test " });
    expect(updated.email).toBe("real.person@example.test");
    expect((await read(row.id)).email).toBe("real.person@example.test");
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist.mock.calls[0]![1].payload.changes).toEqual({
      email: { from: placeholder, to: "real.person@example.test" },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "key-1", metadata: expect.objectContaining({ via: "api" }) }),
    );
  });

  it("returns 409 candidate_email_exists for a duplicate and changes nothing", async () => {
    const taken = await seed("taken@example.test");
    const row = await seed(`boss-${"ab".repeat(12)}@example.invalid`);
    await expect(update(row.id, { email: "TAKEN@example.test" })).rejects.toMatchObject({
      status: 409,
      reason: "candidate_email_exists",
      details: { candidateId: taken.id },
    });
    expect((await read(row.id)).email).toBe(`boss-${"ab".repeat(12)}@example.invalid`);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("is a no-op for the same email: 200 semantics, no write, no event, no updatedAt bump", async () => {
    const row = await seed("same@example.test");
    const before = await read(row.id);
    const result = await update(row.id, { email: "Same@Example.test" });
    expect(result.id).toBe(row.id);
    expect((await read(row.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses to write when expectedEmail no longer matches", async () => {
    const row = await seed("edited-by-human@example.test");
    await expect(
      update(row.id, { email: "new@example.test", expectedEmail: placeholder }),
    ).rejects.toMatchObject({ status: 409, reason: "email_precondition_failed" });
    expect((await read(row.id)).email).toBe("edited-by-human@example.test");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("writes when expectedEmail matches", async () => {
    const row = await seed(`${"cd".repeat(32)}@boss.invalid`);
    const updated = await update(row.id, {
      email: "matched@example.test",
      expectedEmail: `${"CD".repeat(32)}@boss.invalid`,
    });
    expect(updated.email).toBe("matched@example.test");
  });

  it("stores location and clears a nullable field with an explicit null", async () => {
    const row = await seed("fields@example.test");
    await update(row.id, { location: "Remote", phone: "123" });
    expect(await read(row.id)).toMatchObject({ location: "Remote", phone: "123" });
    await update(row.id, { phone: null });
    expect((await read(row.id)).phone).toBeNull();
  });

  it("maps a concurrent unique-index violation to the same 409", async () => {
    const a = await seed("race-a@example.test");
    const b = await seed("race-b@example.test");
    const results = await Promise.allSettled([
      update(a.id, { email: "race-target@example.test" }),
      update(b.id, { email: "race-target@example.test" }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, reason: "candidate_email_exists" });
  });
});
