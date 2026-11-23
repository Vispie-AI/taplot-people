import "server-only";

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { ApiError, type Cursor } from "@harly/api";
import { db, candidates, type Candidate } from "@harly/db";
import type {
  CandidateEducationEntry,
  CandidateExperienceEntry,
} from "@harly/db";

import { emitWebhookEvent } from "@/server/webhooks/emit";
import {
  persistDomainEvent,
  publishPersistedDomainEvents,
} from "@/server/events/emit";
import { logAuditEvent } from "@/lib/audit-log";

/** Workspace-scoped candidate service for the REST API. */

export type CandidateApiInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  location?: string | null;
  headline?: string | null;
  summary?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  websiteUrl?: string | null;
  educationEntries?: CandidateEducationEntry[] | null;
  experienceEntries?: CandidateExperienceEntry[] | null;
};

export function serializeCandidate(candidate: Candidate) {
  return {
    id: candidate.id,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email,
    phone: candidate.phone,
    address: candidate.address,
    location: candidate.address ?? candidate.location,
    headline: candidate.headline,
    summary: candidate.summary,
    linkedinUrl: candidate.linkedinUrl,
    githubUrl: candidate.githubUrl,
    websiteUrl: candidate.websiteUrl,
    educationEntries: candidate.educationEntries,
    experienceEntries: candidate.experienceEntries,
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

/**
 * Postgres stores `created_at` with microsecond precision but a JS `Date` only
 * keeps milliseconds. A cursor built from `Date#toISOString()` therefore
 * rounds the last row's timestamp down, and the keyset comparison then skips
 * every row of the same millisecond that sorts after it (bulk imports create
 * such bursts). The cursor carries the exact database timestamp instead, and
 * the comparison happens in SQL.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createdAtCursorSql = sql<string>`to_char(${candidates.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function cursorWhere(cursor: Cursor | null) {
  if (!cursor) return undefined;
  if (!CURSOR_TIMESTAMP.test(cursor.createdAt) || !UUID.test(cursor.id)) {
    throw ApiError.badRequest("Invalid `cursor`.");
  }
  const createdAt = sql`${cursor.createdAt}::timestamptz`;
  return or(
    sql`${candidates.createdAt} < ${createdAt}`,
    and(sql`${candidates.createdAt} = ${createdAt}`, lt(candidates.id, cursor.id)),
  );
}

export type CandidateListRow = Candidate & {
  /** Exact (microsecond) `created_at`, to build the next-page cursor from. */
  createdAtCursor: string;
};

export async function listCandidatesForApi(input: {
  workspaceId: string;
  cursor: Cursor | null;
  limit: number;
}): Promise<CandidateListRow[]> {
  const rows = await db
    .select({ candidate: candidates, createdAtCursor: createdAtCursorSql })
    .from(candidates)
    .where(
      and(
        eq(candidates.workspaceId, input.workspaceId),
        isNull(candidates.deletedAt),
        cursorWhere(input.cursor),
      ),
    )
    .orderBy(desc(candidates.createdAt), desc(candidates.id))
    .limit(input.limit + 1);
  return rows.map((row) => ({
    ...row.candidate,
    createdAtCursor: row.createdAtCursor,
  }));
}

export async function getCandidateForApi(input: {
  workspaceId: string;
  candidateId: string;
}): Promise<Candidate> {
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.id, input.candidateId),
        eq(candidates.workspaceId, input.workspaceId),
        isNull(candidates.deletedAt),
      ),
    )
    .limit(1);
  if (!candidate) throw ApiError.notFound("Candidate not found.");
  return candidate;
}

export async function createCandidateForApi(input: {
  workspaceId: string;
  values: CandidateApiInput;
}): Promise<Candidate> {
  const email = input.values.email.trim().toLowerCase();

  const { candidate, event } = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: candidates.id })
      .from(candidates)
      .where(
        and(
          eq(candidates.workspaceId, input.workspaceId),
          sql`lower(${candidates.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (existing) {
      throw ApiError.conflict("A candidate with this email already exists.");
    }
    const [created] = await tx
      .insert(candidates)
      .values({
        workspaceId: input.workspaceId,
        firstName: input.values.firstName,
        lastName: input.values.lastName,
        email,
        phone: input.values.phone ?? null,
        address: input.values.address ?? null,
        headline: input.values.headline ?? null,
        summary: input.values.summary ?? null,
        linkedinUrl: input.values.linkedinUrl ?? null,
        githubUrl: input.values.githubUrl ?? null,
        websiteUrl: input.values.websiteUrl ?? null,
        educationEntries: input.values.educationEntries ?? [],
        experienceEntries: input.values.experienceEntries ?? [],
      })
      .returning();
    if (!created) throw ApiError.internal("Candidate could not be created.");
    return {
      candidate: created,
      event: await persistDomainEvent(tx, {
        name: "candidate.created",
        workspaceId: input.workspaceId,
        aggregateType: "candidate",
        aggregateId: created.id,
        payload: { candidate: serializeCandidate(created) },
      }),
    };
  });

  await publishPersistedDomainEvents([event]);
  await emitWebhookEvent(input.workspaceId, "candidate.created", {
    candidate: serializeCandidate(candidate),
    eventId: event.eventId,
  }, { skipDomainEvent: true, eventId: event.eventId });
  await logAuditEvent({
    workspaceId: input.workspaceId,
    action: "candidate.created",
    resourceType: "candidate",
    resourceId: candidate.id,
    severity: "info",
    metadata: { via: "api" },
  });
  return candidate;
}

export async function updateCandidateForApi(input: {
  workspaceId: string;
  candidateId: string;
  values: Partial<CandidateApiInput>;
}): Promise<Candidate> {
  const existing = await getCandidateForApi({
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
  });

  const { updated, event } = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .update(candidates)
      .set({
        firstName: input.values.firstName ?? existing.firstName,
        lastName: input.values.lastName ?? existing.lastName,
        phone: input.values.phone ?? existing.phone,
        address: input.values.address ?? existing.address,
        headline: input.values.headline ?? existing.headline,
        summary: input.values.summary ?? existing.summary,
        linkedinUrl: input.values.linkedinUrl ?? existing.linkedinUrl,
        githubUrl: input.values.githubUrl ?? existing.githubUrl,
        websiteUrl: input.values.websiteUrl ?? existing.websiteUrl,
        educationEntries:
          input.values.educationEntries ?? existing.educationEntries,
        experienceEntries:
          input.values.experienceEntries ?? existing.experienceEntries,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(candidates.id, input.candidateId),
          eq(candidates.workspaceId, input.workspaceId),
        ),
      )
      .returning();
    if (!candidate) throw ApiError.notFound("Candidate not found.");
    return {
      updated: candidate,
      event: await persistDomainEvent(tx, {
        name: "candidate.updated",
        workspaceId: input.workspaceId,
        aggregateType: "candidate",
        aggregateId: candidate.id,
        payload: { candidate: serializeCandidate(candidate) },
      }),
    };
  });

  await publishPersistedDomainEvents([event]);
  await emitWebhookEvent(input.workspaceId, "candidate.updated", {
    candidate: serializeCandidate(updated),
    eventId: event.eventId,
  }, { skipDomainEvent: true, eventId: event.eventId });
  await logAuditEvent({
    workspaceId: input.workspaceId,
    action: "candidate.updated",
    resourceType: "candidate",
    resourceId: input.candidateId,
    severity: "info",
    metadata: { via: "api" },
  });
  return updated;
}

export async function deleteCandidateForApi(input: {
  workspaceId: string;
  candidateId: string;
}): Promise<void> {
  await getCandidateForApi({
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
  });
  await db
    .update(candidates)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(candidates.id, input.candidateId),
        eq(candidates.workspaceId, input.workspaceId),
      ),
    );
  await logAuditEvent({
    workspaceId: input.workspaceId,
    action: "candidate.deleted",
    resourceType: "candidate",
    resourceId: input.candidateId,
    severity: "warning",
    metadata: { via: "api" },
  });
}
