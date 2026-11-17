import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bossResumeImports,
  candidateFiles,
  candidates,
  db,
  organization,
} from "@harly/db";
import { privateResumeFileUrl } from "@/lib/resume/storage-key";
import type { BossResumeInput } from "./boss-resume-input";

vi.mock("server-only", () => ({}));
vi.mock("@/server/events/emit", () => ({
  persistDomainEvent: vi.fn(async () => ({ eventId: randomUUID() })),
  publishPersistedDomainEvents: vi.fn(async () => undefined),
}));
vi.mock("./service", () => ({
  serializeCandidate: (candidate: unknown) => candidate,
}));
const files = vi.hoisted(() => new Map<string, Buffer>());
const fail = vi.hoisted(() => ({ writes: false }));
vi.mock("@/lib/storage", () => ({
  storage: {
    put: vi.fn(async (key: string, bytes: Buffer) => {
      if (fail.writes) throw new Error("Synthetic storage failure");
      files.set(key, Buffer.from(bytes));
    }),
    read: vi.fn(async (key: string) => {
      const bytes = files.get(key);
      if (!bytes) throw new Error("Synthetic missing original");
      return bytes;
    }),
  },
}));

import { importBossResume } from "./boss-resume-service";

const integration =
  process.env.RUN_BOSS_RESUME_IMPORT_INTEGRATION === "1"
    ? describe
    : describe.skip;
const workspaceId = `boss-import-${randomUUID()}`;
function input(
  sourceRecordId: string,
  content = sourceRecordId,
): BossResumeInput {
  const bytes = Buffer.from(`%PDF-1.7\n${content}\n%%EOF`);
  return {
    sourceRecordId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    candidate: { name: "Synthetic Candidate" },
    bytes,
    fileName: "resume.pdf",
    contentType: "application/pdf",
  };
}

integration("BOSS attachment import with PostgreSQL", () => {
  beforeAll(async () => {
    await db
      .insert(organization)
      .values({
        id: workspaceId,
        name: "Synthetic workspace",
        slug: workspaceId,
        createdAt: new Date(),
      });
  });
  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, workspaceId));
  });

  it("imports the same original twice as exactly one candidate attachment", async () => {
    const original = input("rec-repeat");
    const first = await importBossResume(workspaceId, original);
    const second = await importBossResume(workspaceId, original);
    expect(second).toMatchObject({
      candidateId: first.candidateId,
      fileId: first.fileId,
      deduplicated: true,
    });
    const attached = await db
      .select()
      .from(candidateFiles)
      .where(eq(candidateFiles.candidateId, first.candidateId));
    expect(attached).toHaveLength(1);
    expect(attached[0].contentHash).toBe(original.sha256);
  });

  it("serializes concurrent sources for the same bytes", async () => {
    const firstInput = input("rec-concurrent-a", "same concurrent original");
    const results = await Promise.all([
      importBossResume(workspaceId, firstInput),
      importBossResume(workspaceId, {
        ...firstInput,
        sourceRecordId: "rec-concurrent-b",
      }),
    ]);
    expect(results[0].candidateId).toBe(results[1].candidateId);
    expect(results[0].fileId).toBe(results[1].fileId);
    const linked = await db
      .select()
      .from(bossResumeImports)
      .where(eq(bossResumeImports.fileId, results[0].fileId));
    expect(linked).toHaveLength(2);
  });

  it("deduplicates against a pre-existing attachment with no checksum", async () => {
    const original = input("rec-legacy");
    const [existing] = await db
      .insert(candidates)
      .values({
        workspaceId,
        firstName: "Existing",
        lastName: "Candidate",
        email: "existing@example.test",
        headline: "Human maintained",
      })
      .returning();
    const key = `resumes/${randomUUID()}.pdf`;
    files.set(key, original.bytes);
    const [file] = await db
      .insert(candidateFiles)
      .values({
        workspaceId,
        candidateId: existing.id,
        fileName: "old.pdf",
        fileUrl: `/uploads/${key}`,
      })
      .returning();
    const result = await importBossResume(workspaceId, original);
    expect(result).toMatchObject({
      candidateId: existing.id,
      fileId: file.id,
      deduplicated: true,
    });
    const [preserved] = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, existing.id));
    expect(preserved.headline).toBe("Human maintained");
  });

  it("rolls back candidate and progress on upload failure, then retries", async () => {
    const original = input("rec-retry");
    fail.writes = true;
    try {
      await expect(importBossResume(workspaceId, original)).rejects.toThrow(
        "Synthetic storage failure",
      );
    } finally {
      fail.writes = false;
    }
    expect(
      await db
        .select()
        .from(bossResumeImports)
        .where(
          and(
            eq(bossResumeImports.workspaceId, workspaceId),
            eq(bossResumeImports.sourceRecordId, original.sourceRecordId),
          ),
        ),
    ).toHaveLength(0);
    const result = await importBossResume(workspaceId, original);
    expect(result.fileId).toBeTruthy();
  });

  it("keeps a revised source record on the original candidate", async () => {
    const first = await importBossResume(
      workspaceId,
      input("rec-version", "version one"),
    );
    const revised = await importBossResume(
      workspaceId,
      input("rec-version", "version two"),
    );
    expect(revised.candidateId).toBe(first.candidateId);
    expect(revised.fileId).not.toBe(first.fileId);
    const [file] = await db
      .select()
      .from(candidateFiles)
      .where(eq(candidateFiles.id, revised.fileId));
    expect(file.fileUrl).toBe(
      privateResumeFileUrl(
        `workspaces/${workspaceId}/resumes/boss/${revised.sha256}.pdf`,
      ),
    );
  });

  it("rejects a checksum mismatch without advancing progress", async () => {
    await expect(
      importBossResume(workspaceId, {
        ...input("rec-mismatch"),
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("associates a new original with the existing email profile without overwriting it", async () => {
    const [existing] = await db
      .insert(candidates)
      .values({
        workspaceId,
        firstName: "Human",
        lastName: "Maintained",
        email: "email-match@example.test",
        headline: "Human maintained headline",
      })
      .returning();
    const original = input("rec-email-match");
    original.candidate.email = "EMAIL-MATCH@example.test";
    const result = await importBossResume(workspaceId, original);
    expect(result.candidateId).toBe(existing.id);
    const [preserved] = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, existing.id));
    expect(preserved.headline).toBe("Human maintained headline");
    expect(preserved.firstName).toBe("Human");
  });

  it("does not merge different people by a masked phone prefix", async () => {
    const [existing] = await db
      .insert(candidates)
      .values({
        workspaceId,
        firstName: "Existing",
        lastName: "Candidate",
        email: "masked-phone@example.test",
        phone: "138****",
      })
      .returning();
    const original = input("rec-masked-phone");
    original.candidate.phone = "138****";
    const result = await importBossResume(workspaceId, original);
    expect(result.candidateId).not.toBe(existing.id);
  });
});
