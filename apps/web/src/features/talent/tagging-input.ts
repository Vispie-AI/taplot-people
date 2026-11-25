import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, isNull, max, min, sql } from "drizzle-orm";
import { ApiError } from "@harly/api";
import {
  applications,
  candidateFiles,
  candidateTalentProfiles,
  candidates,
  db,
  jobs,
} from "@harly/db";

import { readStoredResumeText } from "@/lib/mcp/tools/candidates/resume-input";

export type TaggingInput = {
  candidateId: string;
  /** Returned so the tagger can remove the name before text leaves for a model. */
  firstName: string;
  lastName: string;
  headline: string | null;
  summary: string | null;
  location: string | null;
  createdAt: string;
  sources: string[];
  applications: { jobId: string; jobTitle: string; source: string | null; appliedAt: string | null }[];
  firstAppliedAt: string | null;
  lastAppliedAt: string | null;
  resume: {
    fileId: string;
    fileName: string;
    uploadedAt: string;
    text: string | null;
    truncated: boolean;
    diagnostics: string[];
  } | null;
  /** sha256 over the fields above that a tagger reads; equal hash = nothing to re-tag. */
  inputHash: string;
  current: { tagVersion: string; inputHash: string | null; taggedAt: string } | null;
};

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/**
 * Everything a tagging service needs for one candidate: profile text, the
 * newest resume's extracted text, application sources and dates, and the hash
 * of the current profile's input so unchanged candidates can be skipped.
 */
export async function loadTaggingInput(input: {
  workspaceId: string;
  candidateId: string;
  maxChars: number;
}): Promise<TaggingInput> {
  const { workspaceId, candidateId } = input;
  const [candidate] = await db
    .select({
      id: candidates.id,
      firstName: candidates.firstName,
      lastName: candidates.lastName,
      headline: candidates.headline,
      summary: candidates.summary,
      location: candidates.location,
      createdAt: candidates.createdAt,
    })
    .from(candidates)
    .where(
      and(
        eq(candidates.id, candidateId),
        eq(candidates.workspaceId, workspaceId),
        isNull(candidates.deletedAt),
        isNull(candidates.anonymizedAt),
      ),
    )
    .limit(1);
  if (!candidate) throw ApiError.notFound("Candidate not found.");

  const [apps, [file], [current], [range]] = await Promise.all([
    db
      .select({
        jobId: applications.jobId,
        jobTitle: jobs.title,
        source: applications.source,
        appliedAt: applications.appliedAt,
      })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.candidateId, candidateId)))
      .orderBy(asc(applications.appliedAt))
      .limit(50),
    db
      .select({
        id: candidateFiles.id,
        fileName: candidateFiles.fileName,
        fileUrl: candidateFiles.fileUrl,
        fileType: candidateFiles.fileType,
        createdAt: candidateFiles.createdAt,
      })
      .from(candidateFiles)
      .where(and(eq(candidateFiles.workspaceId, workspaceId), eq(candidateFiles.candidateId, candidateId)))
      .orderBy(desc(candidateFiles.createdAt))
      .limit(1),
    db
      .select({
        tagVersion: candidateTalentProfiles.tagVersion,
        inputHash: candidateTalentProfiles.inputHash,
        taggedAt: candidateTalentProfiles.taggedAt,
      })
      .from(candidateTalentProfiles)
      .where(
        and(
          eq(candidateTalentProfiles.workspaceId, workspaceId),
          eq(candidateTalentProfiles.candidateId, candidateId),
        ),
      )
      .limit(1),
    db
      .select({
        first: min(applications.appliedAt),
        last: max(applications.appliedAt),
      })
      .from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.candidateId, candidateId))),
  ]);

  let resume: TaggingInput["resume"] = null;
  if (file) {
    const { text, diagnostics } = await readStoredResumeText({
      workspaceId,
      fileUrl: file.fileUrl,
      fileName: file.fileName,
      fileType: file.fileType,
    });
    const cleaned = text?.replace(/\r\n?/g, "\n").trim() ?? null;
    const truncated = Boolean(cleaned && cleaned.length > input.maxChars);
    resume = {
      fileId: file.id,
      fileName: file.fileName,
      uploadedAt: file.createdAt.toISOString(),
      text: cleaned ? cleaned.slice(0, input.maxChars) : null,
      truncated,
      diagnostics,
    };
  }

  const sources = Array.from(
    new Set(apps.map((row) => row.source?.trim()).filter((value): value is string => Boolean(value))),
  );
  const hashed = {
    headline: candidate.headline,
    summary: candidate.summary,
    location: candidate.location,
    sources,
    jobs: apps.map((row) => row.jobId),
    resume: resume ? { fileId: resume.fileId, text: resume.text } : null,
  };
  const inputHash = createHash("sha256").update(JSON.stringify(hashed)).digest("hex");

  return {
    candidateId,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    headline: candidate.headline,
    summary: candidate.summary,
    location: candidate.location,
    createdAt: candidate.createdAt.toISOString(),
    sources,
    applications: apps.map((row) => ({
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      source: row.source,
      appliedAt: iso(row.appliedAt),
    })),
    firstAppliedAt: iso(range?.first ?? null),
    lastAppliedAt: iso(range?.last ?? null),
    resume,
    inputHash,
    current: current
      ? { tagVersion: current.tagVersion, inputHash: current.inputHash, taggedAt: current.taggedAt.toISOString() }
      : null,
  };
}

/** Candidate ids in creation order for a tagging run, keyset-paged. */
export async function listTaggingCandidates(input: {
  workspaceId: string;
  after?: string;
  limit: number;
  untaggedOnly?: boolean;
}): Promise<{ ids: string[]; next: string | null }> {
  const rows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .leftJoin(
      candidateTalentProfiles,
      and(
        eq(candidateTalentProfiles.candidateId, candidates.id),
        eq(candidateTalentProfiles.workspaceId, input.workspaceId),
      ),
    )
    .where(
      and(
        eq(candidates.workspaceId, input.workspaceId),
        isNull(candidates.deletedAt),
        isNull(candidates.anonymizedAt),
        input.after ? sql`${candidates.id} > ${input.after}::uuid` : undefined,
        input.untaggedOnly ? isNull(candidateTalentProfiles.id) : undefined,
      ),
    )
    .orderBy(asc(candidates.id))
    .limit(input.limit + 1);
  const ids = rows.slice(0, input.limit).map((row) => row.id);
  return { ids, next: rows.length > input.limit ? ids[ids.length - 1]! : null };
}
