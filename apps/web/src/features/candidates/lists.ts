import "server-only";

import { and, eq, gt, isNull, or } from "drizzle-orm";

import { candidateLists, db } from "@harly/db";
import {
  cleanDirectoryFilters,
  type DirectoryOriginFilters,
} from "@/features/candidates/origin";

export type CandidateListMode = "filter" | "snapshot";

export type CandidateListRecord = {
  id: string;
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

export async function getCandidateList(
  workspaceId: string,
  listId: string,
): Promise<CandidateListRecord | null> {
  if (!UUID.test(listId)) return null;
  const now = new Date();
  const [row] = await db
    .select()
    .from(candidateLists)
    .where(
      and(
        eq(candidateLists.id, listId),
        eq(candidateLists.workspaceId, workspaceId),
        or(isNull(candidateLists.expiresAt), gt(candidateLists.expiresAt, now)),
      ),
    )
    .limit(1);

  if (!row) return null;
  const mode: CandidateListMode =
    row.mode === "snapshot" ? "snapshot" : "filter";
  const filterSpec =
    row.filterSpec && typeof row.filterSpec === "object"
      ? cleanDirectoryFilters(
          row.filterSpec as Record<string, string | string[] | undefined>,
        )
      : null;

  return {
    id: row.id,
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

  const [created] = await db
    .insert(candidateLists)
    .values({
      workspaceId: input.workspaceId,
      createdById: input.createdById ?? null,
      title: input.title.trim().slice(0, 200),
      description: input.description?.trim().slice(0, 1000) || null,
      mode: input.mode,
      filterSpec: cleanedSpec,
      candidateIds: input.mode === "snapshot" ? uniqueCandidateIds : [],
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (!created) {
    throw new Error("Could not create candidate list.");
  }

  return {
    id: created.id,
    workspaceId: created.workspaceId,
    title: created.title,
    description: created.description,
    mode: created.mode === "snapshot" ? "snapshot" : "filter",
    filterSpec: cleanedSpec,
    candidateIds: created.candidateIds ?? [],
    createdById: created.createdById,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
  };
}
