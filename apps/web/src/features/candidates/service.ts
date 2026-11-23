import "server-only";

import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

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

function cursorWhere(cursor: Cursor | null) {
  if (!cursor) return undefined;
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(candidates.createdAt, createdAt),
    and(eq(candidates.createdAt, createdAt), lt(candidates.id, cursor.id)),
  );
}

export async function listCandidatesForApi(input: {
  workspaceId: string;
  cursor: Cursor | null;
  limit: number;
}): Promise<Candidate[]> {
  return db
    .select()
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
        location: input.values.location ?? null,
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

const CANDIDATE_EMAIL_INDEX = "candidates_workspace_email_idx";

function isCandidateEmailUniqueViolation(error: unknown): boolean {
  // drizzle wraps driver errors, so look at the error and its cause chain.
  for (let e: unknown = error, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const err = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (
      err.code === "23505" &&
      (err.constraint_name === CANDIDATE_EMAIL_INDEX ||
        err.constraint === CANDIDATE_EMAIL_INDEX)
    ) {
      return true;
    }
  }
  return false;
}

function emailExistsError(candidateId?: string) {
  return ApiError.conflictWithReason(
    "candidate_email_exists",
    "Another candidate already uses this email.",
    candidateId ? { candidateId } : undefined,
  );
}

type CandidateUpdateValues = Partial<CandidateApiInput> & {
  /** Optimistic guard: only write when the stored email still equals this. */
  expectedEmail?: string;
};

const UPDATABLE_FIELDS = [
  "firstName",
  "lastName",
  "phone",
  "address",
  "location",
  "headline",
  "summary",
  "linkedinUrl",
  "githubUrl",
  "websiteUrl",
  "educationEntries",
  "experienceEntries",
] as const;

export async function updateCandidateForApi(input: {
  workspaceId: string;
  candidateId: string;
  values: CandidateUpdateValues;
  actorKeyId?: string;
}): Promise<Candidate> {
  const { expectedEmail, ...values } = input.values;
  const newEmail = values.email?.trim().toLowerCase();

  const result = await db
    .transaction(async (tx) => {
      // Lock the row so the precondition, the duplicate check and the write
      // see one consistent state.
      const [existing] = await tx
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.id, input.candidateId),
            eq(candidates.workspaceId, input.workspaceId),
            isNull(candidates.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) throw ApiError.notFound("Candidate not found.");

      if (
        expectedEmail !== undefined &&
        existing.email.trim().toLowerCase() !==
          expectedEmail.trim().toLowerCase()
      ) {
        throw ApiError.conflictWithReason(
          "email_precondition_failed",
          "The stored email no longer matches `expectedEmail`; nothing was written.",
        );
      }

      // `undefined` leaves a field alone; an explicit `null` clears it.
      const set: Partial<typeof candidates.$inferInsert> = {};
      const changedFields: string[] = [];
      for (const field of UPDATABLE_FIELDS) {
        const incoming = values[field];
        if (incoming === undefined) continue;
        const next =
          field === "educationEntries" || field === "experienceEntries"
            ? (incoming ?? [])
            : incoming;
        if (JSON.stringify(next) === JSON.stringify(existing[field])) continue;
        (set as Record<string, unknown>)[field] = next;
        changedFields.push(field);
      }
      const emailChanged =
        newEmail !== undefined &&
        newEmail !== existing.email.trim().toLowerCase();
      if (emailChanged) {
        const [duplicate] = await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(
            and(
              eq(candidates.workspaceId, input.workspaceId),
              sql`lower(${candidates.email}) = ${newEmail}`,
              ne(candidates.id, input.candidateId),
              isNull(candidates.deletedAt),
            ),
          )
          .limit(1);
        if (duplicate) throw emailExistsError(duplicate.id);
        set.email = newEmail;
        changedFields.push("email");
      }

      // Nothing differs (for example the same email sent twice): no write,
      // no `updatedAt` bump, no event.
      if (changedFields.length === 0) {
        return { candidate: existing, event: null, changedFields };
      }

      const [candidate] = await tx
        .update(candidates)
        .set({ ...set, updatedAt: new Date() })
        .where(
          and(
            eq(candidates.id, input.candidateId),
            eq(candidates.workspaceId, input.workspaceId),
          ),
        )
        .returning();
      if (!candidate) throw ApiError.notFound("Candidate not found.");
      return {
        candidate,
        changedFields,
        event: await persistDomainEvent(tx, {
          name: "candidate.updated",
          workspaceId: input.workspaceId,
          aggregateType: "candidate",
          aggregateId: candidate.id,
          payload: {
            candidate: serializeCandidate(candidate),
            changedFields,
            ...(emailChanged
              ? { changes: { email: { from: existing.email, to: newEmail } } }
              : {}),
          },
        }),
      };
    })
    .catch((error: unknown) => {
      // The unique index is the backstop for a concurrent writer that won
      // the race after our duplicate check.
      if (isCandidateEmailUniqueViolation(error)) throw emailExistsError();
      throw error;
    });

  if (!result.event) return result.candidate;

  await publishPersistedDomainEvents([result.event]);
  await emitWebhookEvent(input.workspaceId, "candidate.updated", {
    candidate: serializeCandidate(result.candidate),
    eventId: result.event.eventId,
  }, { skipDomainEvent: true, eventId: result.event.eventId });
  await logAuditEvent({
    workspaceId: input.workspaceId,
    action: "candidate.updated",
    actorId: input.actorKeyId,
    resourceType: "candidate",
    resourceId: input.candidateId,
    severity: "info",
    metadata: { via: "api", changedFields: result.changedFields.join(",") },
  });
  return result.candidate;
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
