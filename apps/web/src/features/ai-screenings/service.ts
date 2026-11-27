import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import {
  bossResumeImports,
  candidateAiScreenings,
  candidates,
  db,
  jobs,
} from "@harly/db";

import { logAuditEvent } from "@/lib/audit-log";

import type { AiScreeningItem, ScreeningVerdict } from "./input";

/**
 * First-pass AI screens per candidate and job. Readers pass a viewer: API keys
 * see the whole workspace; signed-in members (MCP, dashboard) add their role
 * scope through `visibleCandidate`.
 */
export type ScreeningViewer = {
  workspaceId: string;
  visibleCandidate?: SQL;
  /** Public origin for candidate links. */
  appOrigin: string;
};

export type ScreeningWriteAudit = {
  keyId?: string;
  actorId?: string | null;
  ipAddress?: string;
  userAgent?: string;
};

export type ScreeningWriteResult = {
  written: number;
  /** A newer screen of the same candidate and job already exists. */
  skippedOlder: number;
  unresolved: Array<{ index: number; reason: "candidate_not_found" | "source_record_unknown" }>;
};

/** Harly jobs imported from Lark carry the Base record id in their slug. */
export function jobSlugForSource(sourceJobId: string): string {
  return `lark-${sourceJobId.toLowerCase()}`;
}

/**
 * Insert or replace the screens. A screen older than the stored one for the
 * same candidate and job is skipped, so replays and out-of-order batches end
 * in the same state. One audit row per request, counts only.
 */
export async function upsertAiScreenings(input: {
  workspaceId: string;
  items: AiScreeningItem[];
  audit: ScreeningWriteAudit;
}): Promise<ScreeningWriteResult> {
  const { workspaceId, items } = input;
  const result: ScreeningWriteResult = { written: 0, skippedOlder: 0, unresolved: [] };

  const records = [...new Set(items.flatMap((i) => (i.candidateId ? [] : [i.sourceRecordId!])))];
  const byRecord = new Map<string, string>();
  if (records.length > 0) {
    const rows = await db
      .select({ sourceRecordId: bossResumeImports.sourceRecordId, candidateId: bossResumeImports.candidateId })
      .from(bossResumeImports)
      .where(
        and(eq(bossResumeImports.workspaceId, workspaceId), inArray(bossResumeImports.sourceRecordId, records)),
      );
    for (const row of rows) byRecord.set(row.sourceRecordId, row.candidateId);
  }

  const resolved = items.map((item, index) => ({
    item,
    index,
    candidateId: item.candidateId ?? byRecord.get(item.sourceRecordId!) ?? null,
  }));
  const ids = [...new Set(resolved.flatMap((r) => (r.candidateId ? [r.candidateId] : [])))];
  const active = new Set<string>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(
        and(
          eq(candidates.workspaceId, workspaceId),
          inArray(candidates.id, ids),
          isNull(candidates.deletedAt),
          isNull(candidates.anonymizedAt),
        ),
      );
    for (const row of rows) active.add(row.id);
  }

  const slugs = [...new Set(items.map((i) => jobSlugForSource(i.sourceJobId)))];
  const jobBySlug = new Map<string, string>();
  const jobRows = await db
    .select({ id: jobs.id, slug: jobs.slug })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.slug, slugs)));
  for (const row of jobRows) jobBySlug.set(row.slug, row.id);

  for (const { item, index, candidateId } of resolved) {
    if (!candidateId) {
      result.unresolved.push({ index, reason: "source_record_unknown" });
      continue;
    }
    if (!active.has(candidateId)) {
      result.unresolved.push({ index, reason: "candidate_not_found" });
      continue;
    }
    const values = {
      sourceRecordId: item.sourceRecordId ?? null,
      jobId: jobBySlug.get(jobSlugForSource(item.sourceJobId)) ?? null,
      verdict: item.verdict,
      reason: item.reason ?? null,
      criteria: item.criteria,
      model: item.model ?? null,
      screenedAt: new Date(item.screenedAt),
    };
    const rows = await db
      .insert(candidateAiScreenings)
      .values({ workspaceId, candidateId, sourceJobId: item.sourceJobId, ...values })
      .onConflictDoUpdate({
        target: [
          candidateAiScreenings.workspaceId,
          candidateAiScreenings.candidateId,
          candidateAiScreenings.sourceJobId,
        ],
        set: { ...values, updatedAt: new Date() },
        setWhere: sql`${candidateAiScreenings.screenedAt} <= excluded.screened_at`,
      })
      .returning({ id: candidateAiScreenings.id });
    if (rows.length > 0) result.written += 1;
    else result.skippedOlder += 1;
  }

  await logAuditEvent({
    workspaceId,
    actorId: input.audit.actorId ?? undefined,
    action: "candidate.ai_screenings.upserted",
    resourceType: "candidate",
    resourceId: ids.length === 1 ? ids[0] : undefined,
    ipAddress: input.audit.ipAddress,
    userAgent: input.audit.userAgent,
    metadata: {
      apiKeyId: input.audit.keyId ?? null,
      counts: { items: items.length, ...result, unresolved: result.unresolved.length },
    },
  });
  return result;
}

export type AiScreeningView = {
  candidateId: string;
  candidateName: string;
  url: string;
  jobId: string | null;
  jobTitle: string | null;
  sourceJobId: string;
  sourceRecordId: string | null;
  verdict: ScreeningVerdict;
  reason: string | null;
  criteria: Array<{ label: string; result: string; quote?: string }>;
  model: string | null;
  screenedAt: string;
};

export type AiScreeningFilters = {
  candidateId?: string;
  jobId?: string;
  sourceJobId?: string;
  verdict?: ScreeningVerdict;
  /** Screened at or after this instant. */
  since?: Date;
  /** Screened before this instant. */
  until?: Date;
  limit?: number;
  offset?: number;
};

function where(viewer: ScreeningViewer, f: AiScreeningFilters): SQL {
  return and(
    eq(candidateAiScreenings.workspaceId, viewer.workspaceId),
    eq(candidates.workspaceId, viewer.workspaceId),
    isNull(candidates.deletedAt),
    isNull(candidates.anonymizedAt),
    viewer.visibleCandidate,
    f.candidateId ? eq(candidateAiScreenings.candidateId, f.candidateId) : undefined,
    f.jobId ? eq(candidateAiScreenings.jobId, f.jobId) : undefined,
    f.sourceJobId ? eq(candidateAiScreenings.sourceJobId, f.sourceJobId) : undefined,
    f.verdict ? eq(candidateAiScreenings.verdict, f.verdict) : undefined,
    f.since ? gte(candidateAiScreenings.screenedAt, f.since) : undefined,
    f.until ? lt(candidateAiScreenings.screenedAt, f.until) : undefined,
  )!;
}

/** Newest screens first, with exact totals by verdict for the same filter. */
export async function listAiScreenings(viewer: ScreeningViewer, filters: AiScreeningFilters = {}) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const predicate = where(viewer, filters);
  const base = db
    .select({
      candidateId: candidateAiScreenings.candidateId,
      firstName: candidates.firstName,
      lastName: candidates.lastName,
      jobId: candidateAiScreenings.jobId,
      jobTitle: jobs.title,
      sourceJobId: candidateAiScreenings.sourceJobId,
      sourceRecordId: candidateAiScreenings.sourceRecordId,
      verdict: candidateAiScreenings.verdict,
      reason: candidateAiScreenings.reason,
      criteria: candidateAiScreenings.criteria,
      model: candidateAiScreenings.model,
      screenedAt: candidateAiScreenings.screenedAt,
    })
    .from(candidateAiScreenings)
    .innerJoin(candidates, eq(candidates.id, candidateAiScreenings.candidateId))
    .leftJoin(jobs, eq(jobs.id, candidateAiScreenings.jobId))
    .where(predicate);
  const [rows, counts] = await Promise.all([
    base.orderBy(desc(candidateAiScreenings.screenedAt), candidateAiScreenings.id).limit(limit).offset(offset),
    db
      .select({ verdict: candidateAiScreenings.verdict, n: sql<number>`count(*)::int` })
      .from(candidateAiScreenings)
      .innerJoin(candidates, eq(candidates.id, candidateAiScreenings.candidateId))
      .where(predicate)
      .groupBy(candidateAiScreenings.verdict),
  ]);
  const byVerdict = { strong: 0, maybe: 0, no: 0 } as Record<ScreeningVerdict, number>;
  for (const c of counts) if (c.verdict in byVerdict) byVerdict[c.verdict as ScreeningVerdict] = c.n;
  const total = byVerdict.strong + byVerdict.maybe + byVerdict.no;
  const origin = viewer.appOrigin.replace(/\/$/, "");
  const screenings: AiScreeningView[] = rows.map((r) => ({
    candidateId: r.candidateId,
    candidateName: `${r.firstName} ${r.lastName}`.trim(),
    url: `${origin}/dashboard/candidates/${r.candidateId}`,
    jobId: r.jobId,
    jobTitle: r.jobTitle,
    sourceJobId: r.sourceJobId,
    sourceRecordId: r.sourceRecordId,
    verdict: r.verdict as ScreeningVerdict,
    reason: r.reason,
    criteria: (r.criteria as AiScreeningView["criteria"]) ?? [],
    model: r.model,
    screenedAt: r.screenedAt.toISOString(),
  }));
  return {
    total,
    byVerdict,
    limit,
    offset,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    screenings,
  };
}
