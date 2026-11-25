import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "@harly/api";
import {
  applications,
  candidateFiles,
  candidates,
  db,
  jobs,
  jobStages,
} from "@harly/db";

import { storage } from "@/lib/storage";
import { privateResumeFileUrl } from "@/lib/resume/storage-key";
import {
  persistDomainEvent,
  publishPersistedDomainEvents,
} from "@/server/events/emit";
import { serializeCandidate } from "./service";
import type { InterviewBookingResumeInput } from "./interview-booking-input";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
};

function normalizePosition(position: string): string {
  return position
    .replace(/^boss\s*直聘\s*[·•:\-—]\s*/i, "")
    .replace(/[（(][^）)]*[）)]/g, (m) =>
      m.replace("（", "(").replace("）", ")"),
    )
    .trim()
    .toLowerCase();
}

export type SyncInterviewBookingResumeResult = {
  found: boolean;
  candidateId: string | null;
  candidatePath: string | null;
  fileId: string | null;
  applicationId: string | null;
  hasResume: boolean;
  createdCandidate: boolean;
  deduplicated: boolean;
};

export async function syncInterviewBookingResume(
  workspaceId: string,
  input: InterviewBookingResumeInput,
): Promise<SyncInterviewBookingResumeResult> {
  if (input.file && digest(input.file.bytes) !== input.file.sha256) {
    throw ApiError.unprocessable(
      "Document SHA256 does not match the original.",
    );
  }

  const emailLower = input.email.trim().toLowerCase();
  const nameTrim = input.name.trim();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`interview-booking:${workspaceId}:${emailLower}`}, 0))`,
    );

    const active = and(
      eq(candidates.workspaceId, workspaceId),
      isNull(candidates.deletedAt),
      isNull(candidates.anonymizedAt),
    );

    // 1. Resolve matching job (optional) for application linking & disambiguation.
    let targetJobId: string | null = null;
    if (input.jobId) {
      const [explicitJob] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, workspaceId),
            eq(jobs.id, input.jobId),
            isNull(jobs.deletedAt),
          ),
        )
        .limit(1);
      if (!explicitJob) {
        throw ApiError.notFound("Target job not found in this workspace.");
      }
      targetJobId = explicitJob.id;
    } else if (input.position?.trim()) {
      const normalizedPos = normalizePosition(input.position);
      if (normalizedPos && normalizedPos !== "unknown") {
        const workspaceJobs = await tx
          .select({
            id: jobs.id,
            title: jobs.title,
            slug: jobs.slug,
            status: jobs.status,
          })
          .from(jobs)
          .where(and(eq(jobs.workspaceId, workspaceId), isNull(jobs.deletedAt)));
        const matchedJobs = workspaceJobs.filter((job) => {
          if (job.title.startsWith("【作废】")) return false;
          const titleLower = job.title.trim().toLowerCase();
          const slugLower = job.slug.trim().toLowerCase();
          if (titleLower === normalizedPos || slugLower === normalizedPos) {
            return true;
          }
          return titleLower
            .split(/\s+\/\s+/)
            .some((part) => part.trim() === normalizedPos);
        });
        if (matchedJobs.length === 1) {
          targetJobId = matchedJobs[0]!.id;
        } else if (matchedJobs.length > 1) {
          const openMatches = matchedJobs.filter((j) => j.status === "open");
          if (openMatches.length === 1) {
            targetJobId = openMatches[0]!.id;
          }
        }
      }
    }

    // 2. Find existing active candidate: exact email first, then SHA-256 file match
    // (if uploading), then unique exact display name match (for lookup-only or
    // BOSS placeholder profiles).
    let [candidate] = await tx
      .select()
      .from(candidates)
      .where(and(active, sql`lower(${candidates.email}) = ${emailLower}`))
      .limit(1);

    let existingFileId: string | null = null;
    let deduplicated = false;

    if (!candidate && input.file) {
      const [fileMatch] = await tx
        .select({ file: candidateFiles, candidate: candidates })
        .from(candidateFiles)
        .innerJoin(candidates, eq(candidates.id, candidateFiles.candidateId))
        .where(
          and(
            active,
            eq(candidateFiles.workspaceId, workspaceId),
            sql`lower(${candidateFiles.contentHash}) = ${input.file.sha256}`,
          ),
        )
        .orderBy(asc(candidateFiles.createdAt), asc(candidateFiles.id))
        .limit(1);
      if (fileMatch) {
        candidate = fileMatch.candidate;
        existingFileId = fileMatch.file.id;
        deduplicated = true;
      }
    }

    if (!candidate && nameTrim.length >= 2) {
      const nameLower = nameTrim.toLowerCase();
      const nameMatches = await tx
        .select()
        .from(candidates)
        .where(
          and(
            active,
            sql`lower(trim(concat_ws(' ', nullif(trim(${candidates.firstName}), ''), nullif(trim(${candidates.lastName}), '')))) = ${nameLower}`,
          ),
        )
        .limit(3);
      if (nameMatches.length === 1) {
        const only = nameMatches[0]!;
        // For lookup-only mode (no new file), return the unique name match.
        // When uploading a file, only merge by name if it is a BOSS placeholder
        // record (to avoid attaching a file to a namesake with a different real email).
        if (!input.file || only.email.endsWith("@boss.invalid")) {
          candidate = only;
        }
      }
    }

    // Lookup-only mode with no match: do not create a bare candidate.
    if (!candidate && !input.file) {
      return {
        found: false,
        candidateId: null,
        candidatePath: null,
        fileId: null,
        applicationId: null,
        hasResume: false,
        createdCandidate: false,
        deduplicated: false,
        event: undefined,
      };
    }

    // 3. Create candidate when uploading a resume for a new candidate.
    let createdCandidate = false;
    let event;
    if (!candidate) {
      const [created] = await tx
        .insert(candidates)
        .values({
          workspaceId,
          firstName: nameTrim,
          lastName: "",
          email: emailLower,
          headline: input.position?.trim() || null,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        candidate = created;
        createdCandidate = true;
        event = await persistDomainEvent(tx, {
          name: "candidate.created",
          workspaceId,
          aggregateType: "candidate",
          aggregateId: created.id,
          payload: { candidate: serializeCandidate(created) },
        });
      } else {
        [candidate] = await tx
          .select()
          .from(candidates)
          .where(and(active, sql`lower(${candidates.email}) = ${emailLower}`))
          .limit(1);
      }
    }
    if (!candidate) {
      throw ApiError.conflict("Candidate could not be resolved.");
    }

    // 4. Store and attach uploaded resume file (idempotent by candidate + sha256).
    let fileId: string | null = existingFileId;
    if (input.file && !fileId) {
      const [existingForCandidate] = await tx
        .select({ id: candidateFiles.id })
        .from(candidateFiles)
        .where(
          and(
            eq(candidateFiles.workspaceId, workspaceId),
            eq(candidateFiles.candidateId, candidate.id),
            sql`lower(${candidateFiles.contentHash}) = ${input.file.sha256}`,
          ),
        )
        .limit(1);
      if (existingForCandidate) {
        fileId = existingForCandidate.id;
        deduplicated = true;
      } else {
        const extension = EXTENSION_BY_TYPE[input.file.contentType] ?? "pdf";
        const key = `workspaces/${workspaceId}/resumes/interview/${input.file.sha256}.${extension}`;
        await storage.put(key, input.file.bytes, input.file.contentType);
        if (digest(await storage.read(key)) !== input.file.sha256) {
          throw ApiError.internal(
            "Stored resume failed checksum verification.",
          );
        }
        const [insertedFile] = await tx
          .insert(candidateFiles)
          .values({
            workspaceId,
            candidateId: candidate.id,
            contentHash: input.file.sha256,
            fileName: input.file.fileName,
            fileUrl: privateResumeFileUrl(key),
            fileType: input.file.contentType,
            fileSize: input.file.bytes.length,
          })
          .returning({ id: candidateFiles.id });
        fileId = insertedFile?.id ?? null;
      }
    }

    // 5. Link application to matching job when we have a file or an existing candidate
    // without an application for this job yet.
    let applicationId: string | null = null;
    if (targetJobId) {
      const [existingApp] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            eq(applications.workspaceId, workspaceId),
            eq(applications.candidateId, candidate.id),
            eq(applications.jobId, targetJobId),
          ),
        )
        .limit(1);
      if (existingApp) {
        applicationId = existingApp.id;
      } else if (input.file) {
        const [firstStage] = await tx
          .select({ id: jobStages.id })
          .from(jobStages)
          .where(
            and(
              eq(jobStages.workspaceId, workspaceId),
              eq(jobStages.jobId, targetJobId),
              isNull(jobStages.archivedAt),
            ),
          )
          .orderBy(asc(jobStages.order))
          .limit(1);
        const [createdApp] = await tx
          .insert(applications)
          .values({
            workspaceId,
            candidateId: candidate.id,
            jobId: targetJobId,
            currentStageId: firstStage?.id ?? null,
            status: "active",
            source: "interview-booking",
            appliedAt: new Date(),
          })
          .returning({ id: applications.id });
        applicationId = createdApp?.id ?? null;
      }
    }

    // 6. Report whether the candidate has at least one resume file on profile.
    let hasResume = Boolean(fileId);
    if (!hasResume) {
      const [anyFile] = await tx
        .select({ id: candidateFiles.id })
        .from(candidateFiles)
        .where(
          and(
            eq(candidateFiles.workspaceId, workspaceId),
            eq(candidateFiles.candidateId, candidate.id),
          ),
        )
        .limit(1);
      hasResume = Boolean(anyFile);
    }

    return {
      found: true,
      candidateId: candidate.id,
      candidatePath: `/dashboard/candidates/${candidate.id}`,
      fileId,
      applicationId,
      hasResume,
      createdCandidate,
      deduplicated,
      event,
    };
  });

  if (result.event) {
    await publishPersistedDomainEvents([result.event]);
  }

  return {
    found: result.found,
    candidateId: result.candidateId,
    candidatePath: result.candidatePath,
    fileId: result.fileId,
    applicationId: result.applicationId,
    hasResume: result.hasResume,
    createdCandidate: result.createdCandidate,
    deduplicated: result.deduplicated,
  };
}
