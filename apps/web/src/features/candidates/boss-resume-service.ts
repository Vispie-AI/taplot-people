import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "@harly/api";
import {
  applications,
  bossResumeImports,
  candidateFiles,
  candidates,
  db,
  jobs,
  jobStages,
} from "@harly/db";

import { storage } from "@/lib/storage";
import {
  privateResumeFileUrl,
  resumeKeyFromUrl,
} from "@/lib/resume/storage-key";
import { isWorkspaceStorageKey } from "@/lib/storage-validation";
import {
  persistDomainEvent,
  publishPersistedDomainEvents,
} from "@/server/events/emit";
import { serializeCandidate } from "./service";
import type { BossResumeInput } from "./boss-resume-input";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Read through Harly's private adapter, including pre-namespace attachments. */
async function readOriginal(workspaceId: string, fileUrl: string) {
  const key = resumeKeyFromUrl(fileUrl);
  if (
    !key ||
    !(
      key.startsWith("resumes/") ||
      isWorkspaceStorageKey(workspaceId, key, "resumes")
    )
  ) {
    throw ApiError.conflict(
      "An existing resume needs storage reconciliation before import.",
    );
  }
  return storage.read(key);
}

export async function importBossResume(
  workspaceId: string,
  input: BossResumeInput,
) {
  // Validate at the service boundary too, including trusted non-HTTP callers.
  if (digest(input.bytes) !== input.sha256) {
    throw ApiError.unprocessable(
      "Document SHA256 does not match the original.",
    );
  }
  const result = await db.transaction(async (tx) => {
    // Serialize this integration per workspace, across processes and API keys.
    // This covers both same-source retries and different sources sharing bytes.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`boss-resumes:${workspaceId}`}, 0))`,
    );
    const [previous] = await tx
      .select()
      .from(bossResumeImports)
      .where(
        and(
          eq(bossResumeImports.workspaceId, workspaceId),
          eq(bossResumeImports.sourceRecordId, input.sourceRecordId),
        ),
      );
    const active = and(
      eq(candidates.workspaceId, workspaceId),
      isNull(candidates.deletedAt),
      isNull(candidates.anonymizedAt),
    );
    const possibleFiles = await tx
      .select({ file: candidateFiles, candidate: candidates })
      .from(candidateFiles)
      .innerJoin(candidates, eq(candidates.id, candidateFiles.candidateId))
      .where(
        and(
          active,
          eq(candidateFiles.workspaceId, workspaceId),
          or(
            sql`lower(${candidateFiles.contentHash}) = ${input.sha256}`,
            isNull(candidateFiles.contentHash),
            eq(candidateFiles.contentHash, ""),
          ),
        ),
      )
      .orderBy(
        sql`lower(${candidateFiles.contentHash}) = ${input.sha256} desc nulls last`,
        asc(candidateFiles.createdAt),
        asc(candidateFiles.id),
      );
    let existingFile: (typeof possibleFiles)[number] | undefined;
    for (const row of possibleFiles) {
      const hash = digest(await readOriginal(workspaceId, row.file.fileUrl));
      if (row.file.contentHash && row.file.contentHash.toLowerCase() !== hash) {
        throw ApiError.conflict(
          "An existing attachment checksum requires reconciliation.",
        );
      }
      if (!row.file.contentHash) {
        await tx
          .update(candidateFiles)
          .set({ contentHash: hash })
          .where(eq(candidateFiles.id, row.file.id));
      }
      if (hash === input.sha256) {
        existingFile = row;
        break;
      }
    }
    let candidate = existingFile?.candidate;
    if (previous) {
      const [linked] = await tx
        .select()
        .from(candidates)
        .where(and(active, eq(candidates.id, previous.candidateId)));
      if (!linked || (candidate && candidate.id !== linked.id)) {
        throw ApiError.conflict(
          "Source candidate is deleted, anonymized, or conflicts with the matching attachment.",
        );
      }
      candidate = linked;
    }
    if (!candidate) {
      const email = input.candidate.email?.toLowerCase();
      const phone = input.candidate.phone?.replace(/[^0-9+]/g, "");
      const matches = await tx
        .select()
        .from(candidates)
        .where(
          and(
            active,
            or(
              email ? sql`lower(${candidates.email}) = ${email}` : sql`false`,
              phone && phone.replace(/\D/g, "").length >= 7
                ? sql`regexp_replace(${candidates.phone}, '[^0-9+]', '', 'g') = ${phone}`
                : sql`false`,
            ),
          ),
        )
        .limit(2);
      if (matches.length > 1)
        throw ApiError.conflict(
          "Candidate contact information matches multiple profiles.",
        );
      candidate = matches[0];
    }
    let event;
    if (!candidate) {
      // BOSS often withholds email. Never merge people by display name alone.
      const email =
        input.candidate.email?.toLowerCase() ??
        `${digest(Buffer.from(input.sourceRecordId))}@boss.invalid`;
      const values = {
        workspaceId,
        firstName: input.candidate.name,
        lastName: "",
        email,
        phone: input.candidate.phone ?? null,
        headline: input.candidate.position ?? null,
      };
      const [created] = await tx
        .insert(candidates)
        .values(values)
        .onConflictDoNothing()
        .returning();
      candidate = created;
      if (created) {
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
          .where(and(active, sql`lower(${candidates.email}) = ${email}`));
      }
    }
    if (!candidate) throw ApiError.conflict("Candidate could not be resolved.");
    let file = existingFile?.file;
    if (!file) {
      const extension = {
        "application/pdf": "pdf",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          "docx",
      }[input.contentType];
      const key = `workspaces/${workspaceId}/resumes/boss/${input.sha256}.${extension}`;
      // Deterministic key makes interrupted writes retryable without extra objects.
      await storage.put(key, input.bytes, input.contentType);
      if (digest(await storage.read(key)) !== input.sha256) {
        throw ApiError.internal(
          "Stored original failed checksum verification.",
        );
      }
      [file] = await tx
        .insert(candidateFiles)
        .values({
          workspaceId,
          candidateId: candidate.id,
          contentHash: input.sha256,
          fileName: input.fileName,
          fileUrl: privateResumeFileUrl(key),
          fileType: input.contentType,
          fileSize: input.bytes.length,
        })
        .returning();
    }
    if (!file) throw ApiError.internal("Attachment could not be linked.");
    // Commit the checkpoint atomically with the verified candidate attachment.
    await tx
      .insert(bossResumeImports)
      .values({
        workspaceId,
        sourceRecordId: input.sourceRecordId,
        contentHash: input.sha256,
        candidateId: candidate.id,
        fileId: file.id,
      })
      .onConflictDoUpdate({
        target: [
          bossResumeImports.workspaceId,
          bossResumeImports.sourceRecordId,
        ],
        set: {
          contentHash: input.sha256,
          candidateId: candidate.id,
          fileId: file.id,
          updatedAt: new Date(),
        },
      });
    // Optionally link an application to a matching job so BOSS resumes are
    // discoverable by department, role, jobId, and applied date filters.
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
    } else if (input.candidate.position?.trim()) {
      const normalizedPos = input.candidate.position
        .replace(/^boss\s*直聘\s*[·•:\-—]\s*/i, "")
        .replace(/[（(][^）)]*[）)]/g, (m) => m.replace("（", "(").replace("）", ")"))
        .trim()
        .toLowerCase();
      if (normalizedPos && normalizedPos !== "unknown") {
        const workspaceJobs = await tx
          .select({ id: jobs.id, title: jobs.title, slug: jobs.slug, status: jobs.status })
          .from(jobs)
          .where(and(eq(jobs.workspaceId, workspaceId), isNull(jobs.deletedAt)));
        const matchedJobs = workspaceJobs.filter((job) => {
          if (job.title.startsWith("【作废】")) return false;
          const titleLower = job.title.trim().toLowerCase();
          const slugLower = job.slug.trim().toLowerCase();
          if (titleLower === normalizedPos || slugLower === normalizedPos) return true;
          // Match either side of bilingual "中文名 / English Title" job titles.
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
      } else {
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
            source: input.source ?? "boss",
            appliedAt: input.appliedAt ? new Date(input.appliedAt) : new Date(),
          })
          .returning({ id: applications.id });
        applicationId = createdApp?.id ?? null;
      }
    }

    return {
      candidateId: candidate.id,
      fileId: file.id,
      applicationId,
      sha256: input.sha256,
      sourceRecordId: input.sourceRecordId,
      deduplicated: Boolean(existingFile),
      event,
    };
  });
  if (result.event) await publishPersistedDomainEvents([result.event]);
  return {
    candidateId: result.candidateId,
    fileId: result.fileId,
    applicationId: result.applicationId,
    sha256: result.sha256,
    sourceRecordId: result.sourceRecordId,
    deduplicated: result.deduplicated,
  };
}
