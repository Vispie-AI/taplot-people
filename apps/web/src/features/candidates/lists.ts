import "server-only";

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { candidateLists, db } from "@harly/db";
import {
  cleanDirectoryFilters,
  isShortId,
  type DirectoryOriginFilters,
} from "@/features/candidates/origin";
import { generateShortId } from "@/features/candidates/short-links";

export type CandidateListMode = "filter" | "snapshot";

export type CandidateListRecord = {
  id: string;
  /** Short public id behind `/v/<shortId>`; null for lists saved before short links. */
  shortId: string | null;
  workspaceId: string;
  title: string;
  description: string | null;
  mode: CandidateListMode;
  filterSpec: DirectoryOriginFilters | null;
  candidateIds: string[];
  createdById: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CandidateListRow = typeof candidateLists.$inferSelect;

function toRecord(row: CandidateListRow): CandidateListRecord {
  const mode: CandidateListMode = row.mode === "snapshot" ? "snapshot" : "filter";
  const filterSpec =
    row.filterSpec && typeof row.filterSpec === "object"
      ? cleanDirectoryFilters(
          row.filterSpec as Record<string, string | string[] | undefined>,
        )
      : null;
  return {
    id: row.id,
    shortId: row.shortId,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    mode,
    filterSpec,
    candidateIds: row.candidateIds ?? [],
    createdById: row.createdById,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** A saved list by its UUID or its short id (`/v/<shortId>`), within one workspace. */
export async function getCandidateList(
  workspaceId: string,
  listId: string,
): Promise<CandidateListRecord | null> {
  const key = listId.trim().toLowerCase();
  const byId = UUID.test(key);
  if (!byId && !isShortId(key)) return null;
  const now = new Date();
  const [row] = await db
    .select()
    .from(candidateLists)
    .where(
      and(
        byId ? eq(candidateLists.id, key) : eq(candidateLists.shortId, key),
        eq(candidateLists.workspaceId, workspaceId),
        or(isNull(candidateLists.expiresAt), gt(candidateLists.expiresAt, now)),
      ),
    )
    .limit(1);

  return row ? toRecord(row) : null;
}

const SHORT_ID_ATTEMPTS = 8;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

/**
 * Gives a list saved before short links a short id (idempotent). Retries on
 * the rare id collision.
 */
export async function ensureCandidateListShortId(
  list: CandidateListRecord,
): Promise<CandidateListRecord> {
  if (list.shortId) return list;
  for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS; attempt += 1) {
    try {
      const [row] = await db
        .update(candidateLists)
        .set({ shortId: generateShortId() })
        .where(
          and(
            eq(candidateLists.id, list.id),
            eq(candidateLists.workspaceId, list.workspaceId),
            isNull(candidateLists.shortId),
          ),
        )
        .returning();
      if (row) return toRecord(row);
      // Someone else set it first.
      const current = await getCandidateList(list.workspaceId, list.id);
      if (current?.shortId) return current;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error("Could not allocate a short link id.");
}

/** An existing, unexpired saved filter with exactly this filter spec, if any. */
export async function findFilterListBySpec(
  workspaceId: string,
  filterSpec: DirectoryOriginFilters,
): Promise<CandidateListRecord | null> {
  const wanted = canonicalSpec(cleanDirectoryFilters(filterSpec));
  const now = new Date();
  const rows = await db
    .select()
    .from(candidateLists)
    .where(
      and(
        eq(candidateLists.workspaceId, workspaceId),
        eq(candidateLists.mode, "filter"),
        or(isNull(candidateLists.expiresAt), gt(candidateLists.expiresAt, now)),
      ),
    )
    .orderBy(desc(candidateLists.createdAt))
    .limit(500);
  for (const row of rows) {
    const record = toRecord(row);
    if (record.filterSpec && canonicalSpec(record.filterSpec) === wanted) return record;
  }
  return null;
}

function canonicalSpec(filters: DirectoryOriginFilters): string {
  const entries = Object.entries(filters)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export async function createCandidateList(input: {
  workspaceId: string;
  createdById?: string | null;
  title: string;
  description?: string | null;
  mode: CandidateListMode;
  filterSpec?: DirectoryOriginFilters | null;
  candidateIds?: string[];
  expiresAt?: Date | null;
}): Promise<CandidateListRecord> {
  const uniqueCandidateIds = Array.from(
    new Set((input.candidateIds ?? []).filter((id) => UUID.test(id))),
  ).slice(0, 500);
  const cleanedSpec = input.filterSpec
    ? cleanDirectoryFilters(input.filterSpec)
    : null;

  let created: CandidateListRow | undefined;
  for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS && !created; attempt += 1) {
    try {
      [created] = await db
        .insert(candidateLists)
        .values({
          workspaceId: input.workspaceId,
          createdById: input.createdById ?? null,
          shortId: generateShortId(),
          title: input.title.trim().slice(0, 200),
          description: input.description?.trim().slice(0, 1000) || null,
          mode: input.mode,
          filterSpec: cleanedSpec,
          candidateIds: input.mode === "snapshot" ? uniqueCandidateIds : [],
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (!created) {
    throw new Error("Could not create candidate list.");
  }

  return { ...toRecord(created), filterSpec: cleanedSpec };
}
