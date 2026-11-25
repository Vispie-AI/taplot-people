import "server-only";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "@harly/api";
import {
  applicationStageHistory,
  applications,
  candidateMessages,
  candidateTalentMatches,
  candidateTalentProfiles,
  candidates,
  db,
  effectiveStageKindSql,
  interviews,
  jobStages,
} from "@harly/db";

import { logAuditEvent } from "@/lib/audit-log";

import type { NormalizedTalentProfile } from "./profile-input";

/**
 * Talent profiles: structured tags with evidence, per-posting match scores, a
 * search over them and pool statistics. Callers pass a viewer: API keys see the
 * whole workspace; signed-in members (MCP, dashboard) add their role scope via
 * `visibleCandidate`, a predicate on `candidates.id` from `candidateScopeSql`.
 */
export type TalentViewer = {
  workspaceId: string;
  visibleCandidate?: SQL;
  /** Public origin for candidate links, e.g. https://people.example.com */
  appOrigin: string;
};

/** Stage kinds that mean someone at the company has engaged the candidate. */
const CONTACT_STAGE_KINDS = ["interview", "offer", "hired"] as const;

function contactStageKindIn(): SQL {
  return sql`${effectiveStageKindSql({ kind: jobStages.kind, name: jobStages.name })} in (${sql.join(
    CONTACT_STAGE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

/**
 * True when the company has engaged the candidate inside Harly: an interview
 * was scheduled, a message was sent to them, or any application is or was in
 * an interview, offer or hired stage. Contact made outside Harly (BOSS chat,
 * phone) is not visible here.
 */
export function contactedSql(workspaceId: string): SQL<boolean> {
  return sql<boolean>`(
    exists (select 1 from ${interviews} where ${interviews.workspaceId} = ${workspaceId} and ${interviews.candidateId} = ${candidates.id})
    or exists (select 1 from ${candidateMessages} where ${candidateMessages.workspaceId} = ${workspaceId} and ${candidateMessages.candidateId} = ${candidates.id} and ${candidateMessages.direction} = 'outbound')
    or exists (select 1 from ${applications} inner join ${jobStages} on ${jobStages.id} = ${applications.currentStageId} where ${applications.workspaceId} = ${workspaceId} and ${applications.candidateId} = ${candidates.id} and ${contactStageKindIn()})
    or exists (select 1 from ${applicationStageHistory} inner join ${applications} on ${applications.id} = ${applicationStageHistory.applicationId} inner join ${jobStages} on ${jobStages.id} = ${applicationStageHistory.toStageId} where ${applicationStageHistory.workspaceId} = ${workspaceId} and ${applications.candidateId} = ${candidates.id} and ${contactStageKindIn()})
  )`;
}

function activeCandidate(viewer: TalentViewer): SQL {
  return and(
    eq(candidates.workspaceId, viewer.workspaceId),
    isNull(candidates.deletedAt),
    isNull(candidates.anonymizedAt),
    viewer.visibleCandidate,
  )!;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type TalentWriteAudit = {
  keyId?: string;
  actorId?: string | null;
  ipAddress?: string;
  userAgent?: string;
};

async function requireActiveCandidate(workspaceId: string, candidateId: string) {
  const [row] = await db
    .select({ id: candidates.id })
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
  if (!row) throw ApiError.notFound("Candidate not found.");
}

/** Replace the candidate's talent profile and matches in one transaction. */
export async function upsertTalentProfile(input: {
  workspaceId: string;
  candidateId: string;
  profile: NormalizedTalentProfile;
  audit: TalentWriteAudit;
}): Promise<{ created: boolean }> {
  const { workspaceId, candidateId, profile } = input;
  await requireActiveCandidate(workspaceId, candidateId);

  const values = {
    tagVersion: profile.tagVersion,
    inputHash: profile.inputHash ?? null,
    engine: profile.engine,
    model: profile.model ?? null,
    city: profile.city ?? null,
    experienceYears: profile.experienceYears ?? null,
    education: profile.education ?? null,
    skills: profile.skills,
    roles: profile.roles,
    companies: profile.companies,
    keyCompanies: profile.keyCompanies,
    industries: profile.industries,
    workKinds: profile.workKinds,
    sourceChannels: profile.sourceChannels,
    works: profile.works,
    evidence: profile.evidence,
    bestPostingKey: profile.bestPostingKey,
    bestScore: profile.bestScore,
    firstContactAt: profile.firstContactAt ? new Date(profile.firstContactAt) : null,
    lastActiveAt: profile.lastActiveAt ? new Date(profile.lastActiveAt) : null,
    taggedAt: new Date(profile.taggedAt),
  };

  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: candidateTalentProfiles.id })
      .from(candidateTalentProfiles)
      .where(
        and(
          eq(candidateTalentProfiles.workspaceId, workspaceId),
          eq(candidateTalentProfiles.candidateId, candidateId),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      await tx
        .update(candidateTalentProfiles)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(candidateTalentProfiles.id, existing.id));
    } else {
      await tx
        .insert(candidateTalentProfiles)
        .values({ workspaceId, candidateId, ...values })
        .onConflictDoUpdate({
          target: [candidateTalentProfiles.workspaceId, candidateTalentProfiles.candidateId],
          set: { ...values, updatedAt: new Date() },
        });
    }
    await tx
      .delete(candidateTalentMatches)
      .where(
        and(
          eq(candidateTalentMatches.workspaceId, workspaceId),
          eq(candidateTalentMatches.candidateId, candidateId),
        ),
      );
    if (profile.matches.length > 0) {
      await tx.insert(candidateTalentMatches).values(
        profile.matches.map((match) => ({
          workspaceId,
          candidateId,
          postingKey: match.postingKey,
          postingLabel: match.postingLabel ?? null,
          jobId: match.jobId ?? null,
          score: match.score,
          tier: match.tier ?? null,
          reason: match.reason ?? null,
          evidence: match.evidence,
        })),
      );
    }
    return !existing;
  });

  await logAuditEvent({
    workspaceId,
    actorId: input.audit.actorId ?? undefined,
    action: created ? "candidate.talent_profile.created" : "candidate.talent_profile.updated",
    resourceType: "candidate",
    resourceId: candidateId,
    ipAddress: input.audit.ipAddress,
    userAgent: input.audit.userAgent,
    metadata: {
      apiKeyId: input.audit.keyId ?? null,
      engine: profile.engine,
      model: profile.model ?? null,
      tagVersion: profile.tagVersion,
      inputHash: profile.inputHash ?? null,
      counts: {
        skills: profile.skills.length,
        roles: profile.roles.length,
        companies: profile.companies.length,
        keyCompanies: profile.keyCompanies.length,
        industries: profile.industries.length,
        works: profile.works.length,
        evidence: profile.evidence.length,
        matches: profile.matches.length,
      },
      bestPostingKey: profile.bestPostingKey,
      bestScore: profile.bestScore,
    },
  });
  return { created };
}

/** Remove the candidate's talent profile and matches. Returns false when none existed. */
export async function deleteTalentProfile(input: {
  workspaceId: string;
  candidateId: string;
  audit: TalentWriteAudit;
}): Promise<boolean> {
  const { workspaceId, candidateId } = input;
  const deleted = await db.transaction(async (tx) => {
    await tx
      .delete(candidateTalentMatches)
      .where(
        and(
          eq(candidateTalentMatches.workspaceId, workspaceId),
          eq(candidateTalentMatches.candidateId, candidateId),
        ),
      );
    const rows = await tx
      .delete(candidateTalentProfiles)
      .where(
        and(
          eq(candidateTalentProfiles.workspaceId, workspaceId),
          eq(candidateTalentProfiles.candidateId, candidateId),
        ),
      )
      .returning({ id: candidateTalentProfiles.id });
    return rows.length > 0;
  });
  if (deleted) {
    await logAuditEvent({
      workspaceId,
      actorId: input.audit.actorId ?? undefined,
      action: "candidate.talent_profile.deleted",
      resourceType: "candidate",
      resourceId: candidateId,
      ipAddress: input.audit.ipAddress,
      userAgent: input.audit.userAgent,
      metadata: { apiKeyId: input.audit.keyId ?? null },
    });
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type TalentEvidence = { field: string; value?: string; quote: string };
export type TalentMatch = {
  postingKey: string;
  postingLabel: string | null;
  jobId: string | null;
  score: number;
  tier: string | null;
  reason: string | null;
  evidence: { quote: string }[];
};

export type TalentProfileView = {
  candidateId: string;
  name: string;
  headline: string | null;
  location: string | null;
  url: string;
  tagVersion: string;
  engine: string;
  model: string | null;
  taggedAt: string;
  city: string | null;
  experienceYears: number | null;
  education: string | null;
  skills: string[];
  roles: string[];
  companies: string[];
  keyCompanies: string[];
  industries: string[];
  workKinds: string[];
  sourceChannels: string[];
  works: { kind: string; title: string; metric?: string }[];
  firstContactAt: string | null;
  lastActiveAt: string | null;
  contacted: boolean;
  best: { postingKey: string; score: number } | null;
  matches: TalentMatch[];
  evidence?: TalentEvidence[];
};

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

function profileColumns(workspaceId: string) {
  return {
    candidateId: candidates.id,
    firstName: candidates.firstName,
    lastName: candidates.lastName,
    headline: candidates.headline,
    location: sql<string | null>`coalesce(${candidates.location}, ${candidates.address})`,
    candidateCreatedAt: candidates.createdAt,
    contacted: contactedSql(workspaceId),
    profile: candidateTalentProfiles,
  };
}

type ProfileRow = {
  candidateId: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  location: string | null;
  candidateCreatedAt: Date;
  contacted: boolean;
  profile: typeof candidateTalentProfiles.$inferSelect;
};

async function matchesFor(workspaceId: string, candidateIds: string[]) {
  const byCandidate = new Map<string, TalentMatch[]>();
  if (candidateIds.length === 0) return byCandidate;
  const rows = await db
    .select()
    .from(candidateTalentMatches)
    .where(
      and(
        eq(candidateTalentMatches.workspaceId, workspaceId),
        sql`${candidateTalentMatches.candidateId} in (${sql.join(
          candidateIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      ),
    );
  for (const row of rows) {
    const list = byCandidate.get(row.candidateId) ?? [];
    list.push({
      postingKey: row.postingKey,
      postingLabel: row.postingLabel,
      jobId: row.jobId,
      score: row.score,
      tier: row.tier,
      reason: row.reason,
      evidence: (row.evidence as { quote: string }[]) ?? [],
    });
    byCandidate.set(row.candidateId, list);
  }
  for (const list of byCandidate.values()) list.sort((a, b) => b.score - a.score);
  return byCandidate;
}

function toView(
  row: ProfileRow,
  matches: TalentMatch[],
  includeEvidence: boolean,
  appOrigin: string,
): TalentProfileView {
  const p = row.profile;
  return {
    candidateId: row.candidateId,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
    headline: row.headline,
    location: row.location,
    url: `${appOrigin.replace(/\/$/, "")}/dashboard/candidates/${row.candidateId}`,
    tagVersion: p.tagVersion,
    engine: p.engine,
    model: p.model,
    taggedAt: iso(p.taggedAt)!,
    city: p.city,
    experienceYears: p.experienceYears,
    education: p.education,
    skills: p.skills,
    roles: p.roles,
    companies: p.companies,
    keyCompanies: p.keyCompanies,
    industries: p.industries,
    workKinds: p.workKinds,
    sourceChannels: p.sourceChannels,
    works: (p.works as TalentProfileView["works"]) ?? [],
    firstContactAt: iso(p.firstContactAt) ?? iso(row.candidateCreatedAt),
    lastActiveAt: iso(p.lastActiveAt),
    contacted: Boolean(row.contacted),
    best:
      p.bestPostingKey && p.bestScore !== null
        ? { postingKey: p.bestPostingKey, score: p.bestScore }
        : null,
    matches,
    ...(includeEvidence ? { evidence: (p.evidence as TalentEvidence[]) ?? [] } : {}),
  };
}

export async function getTalentProfile(
  viewer: TalentViewer,
  candidateId: string,
): Promise<TalentProfileView | null> {
  const [row] = await db
    .select(profileColumns(viewer.workspaceId))
    .from(candidateTalentProfiles)
    .innerJoin(candidates, eq(candidates.id, candidateTalentProfiles.candidateId))
    .where(
      and(
        eq(candidateTalentProfiles.workspaceId, viewer.workspaceId),
        eq(candidateTalentProfiles.candidateId, candidateId),
        activeCandidate(viewer),
      ),
    )
    .limit(1);
  if (!row) return null;
  const matches = await matchesFor(viewer.workspaceId, [candidateId]);
  return toView(row as ProfileRow, matches.get(candidateId) ?? [], true, viewer.appOrigin);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const TALENT_SORTS = ["score", "recent", "first_contact", "last_active"] as const;
export type TalentSort = (typeof TALENT_SORTS)[number];

export type TalentSearchFilters = {
  query?: string;
  skills?: string[];
  roles?: string[];
  companies?: string[];
  keyCompanies?: string[];
  industries?: string[];
  workKinds?: string[];
  sourceChannels?: string[];
  city?: string;
  education?: string[];
  minYears?: number;
  maxYears?: number;
  postingKey?: string;
  minScore?: number;
  contacted?: boolean;
  jobId?: string;
  firstContactAfter?: string;
  firstContactBefore?: string;
  lastActiveAfter?: string;
  lastActiveBefore?: string;
  sort?: TalentSort;
  limit?: number;
  offset?: number;
  includeEvidence?: boolean;
};

const clean = (values: string[] | undefined) =>
  Array.from(
    new Set((values ?? []).map((value) => value.normalize("NFKC").trim()).filter(Boolean)),
  ).slice(0, 50);

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/** Any element of the array column equals one of the values, case-insensitively. */
function arrayHasAny(column: SQL | AnyPgColumn, values: string[]): SQL {
  return sql`exists (select 1 from unnest(${column}) as tag(value) where lower(tag.value) in (${sql.join(
    values.map((value) => sql`${value.toLocaleLowerCase()}`),
    sql`, `,
  )}))`;
}

/** Any element of the array column contains one of the values, case-insensitively. */
function arrayContainsAny(column: SQL | AnyPgColumn, values: string[]): SQL {
  return sql`exists (select 1 from unnest(${column}) as tag(value) where ${sql.join(
    values.map((value) => sql`tag.value ilike ${`%${escapeLike(value)}%`}`),
    sql` or `,
  )})`;
}

function parseBound(value: string | undefined, field: string, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`${field} must be a YYYY-MM-DD date or an ISO 8601 timestamp.`);
  }
  return date;
}

export function buildTalentPredicates(viewer: TalentViewer, filters: TalentSearchFilters): SQL[] {
  const p = candidateTalentProfiles;
  const predicates: SQL[] = [eq(p.workspaceId, viewer.workspaceId), activeCandidate(viewer)];

  const query = filters.query?.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 100);
  if (query) {
    const terms = query.split(" ").filter(Boolean).slice(0, 8);
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      predicates.push(sql`(
        array_to_string(${p.skills} || ${p.roles} || ${p.companies} || ${p.keyCompanies} || ${p.industries} || ${p.workKinds}, ' ') ilike ${like}
        or ${p.works}::text ilike ${like}
        or ${p.evidence}::text ilike ${like}
        or coalesce(${p.city}, '') ilike ${like}
        or coalesce(${candidates.headline}, '') ilike ${like}
        or coalesce(${candidates.summary}, '') ilike ${like}
        or (coalesce(${candidates.firstName}, '') || ' ' || coalesce(${candidates.lastName}, '')) ilike ${like}
      )`);
    }
  }

  const exact: [SQL | AnyPgColumn, string[] | undefined][] = [
    [p.skills, filters.skills],
    [p.roles, filters.roles],
    [p.industries, filters.industries],
    [p.workKinds, filters.workKinds],
    [p.sourceChannels, filters.sourceChannels],
  ];
  for (const [column, values] of exact) {
    const list = clean(values);
    if (list.length > 0) predicates.push(arrayHasAny(column, list));
  }
  for (const [column, values] of [
    [p.companies, filters.companies],
    [p.keyCompanies, filters.keyCompanies],
  ] as const) {
    const list = clean(values);
    if (list.length > 0) predicates.push(arrayContainsAny(column, list));
  }

  if (filters.city?.trim()) {
    predicates.push(sql`${p.city} ilike ${`%${escapeLike(filters.city.trim())}%`}`);
  }
  const education = clean(filters.education);
  if (education.length > 0) {
    predicates.push(sql`${p.education} in (${sql.join(education.map((value) => sql`${value}`), sql`, `)})`);
  }
  if (filters.minYears !== undefined) predicates.push(sql`${p.experienceYears} >= ${filters.minYears}`);
  if (filters.maxYears !== undefined) predicates.push(sql`${p.experienceYears} <= ${filters.maxYears}`);

  if (filters.postingKey) {
    const minScore = filters.minScore ?? 0;
    predicates.push(
      sql`exists (select 1 from ${candidateTalentMatches} where ${candidateTalentMatches.workspaceId} = ${viewer.workspaceId} and ${candidateTalentMatches.candidateId} = ${p.candidateId} and ${candidateTalentMatches.postingKey} = ${filters.postingKey} and ${candidateTalentMatches.score} >= ${minScore})`,
    );
  } else if (filters.minScore !== undefined) {
    predicates.push(sql`${p.bestScore} >= ${filters.minScore}`);
  }

  if (filters.contacted !== undefined) {
    predicates.push(filters.contacted ? contactedSql(viewer.workspaceId) : sql`not ${contactedSql(viewer.workspaceId)}`);
  }
  if (filters.jobId) {
    predicates.push(
      sql`exists (select 1 from ${applications} where ${applications.workspaceId} = ${viewer.workspaceId} and ${applications.candidateId} = ${p.candidateId} and ${applications.jobId} = ${filters.jobId}::uuid)`,
    );
  }

  const firstContact = sql`coalesce(${p.firstContactAt}, ${candidates.createdAt})`;
  const bounds: [SQL | AnyPgColumn, string | undefined, string, ">=" | "<="][] = [
    [firstContact, filters.firstContactAfter, "firstContactAfter", ">="],
    [firstContact, filters.firstContactBefore, "firstContactBefore", "<="],
    [p.lastActiveAt, filters.lastActiveAfter, "lastActiveAfter", ">="],
    [p.lastActiveAt, filters.lastActiveBefore, "lastActiveBefore", "<="],
  ];
  for (const [column, value, field, op] of bounds) {
    const date = parseBound(value, field, op === "<=");
    if (!date) continue;
    const bound = date.toISOString();
    predicates.push(
      op === ">=" ? sql`${column} >= ${bound}::timestamptz` : sql`${column} <= ${bound}::timestamptz`,
    );
  }
  return predicates;
}

export type TalentSearchResult = {
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  candidates: TalentProfileView[];
};

export async function searchTalent(
  viewer: TalentViewer,
  filters: TalentSearchFilters,
): Promise<TalentSearchResult> {
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 25), 1), 100);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const p = candidateTalentProfiles;
  const where = and(...buildTalentPredicates(viewer, filters));

  const postingScore = filters.postingKey
    ? sql`(select ${candidateTalentMatches.score} from ${candidateTalentMatches} where ${candidateTalentMatches.workspaceId} = ${viewer.workspaceId} and ${candidateTalentMatches.candidateId} = ${p.candidateId} and ${candidateTalentMatches.postingKey} = ${filters.postingKey})`
    : sql`${p.bestScore}`;
  const sort = filters.sort ?? (filters.postingKey || filters.minScore !== undefined ? "score" : "recent");
  const order: SQL[] =
    sort === "score"
      ? [sql`${postingScore} desc nulls last`, sql`${p.lastActiveAt} desc nulls last`]
      : sort === "first_contact"
        ? [sql`coalesce(${p.firstContactAt}, ${candidates.createdAt}) desc`]
        : sort === "last_active"
          ? [sql`${p.lastActiveAt} desc nulls last`]
          : [sql`${p.taggedAt} desc`];
  order.push(sql`${p.candidateId} asc`);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(p)
    .innerJoin(candidates, eq(candidates.id, p.candidateId))
    .where(where);
  const rows = await db
    .select(profileColumns(viewer.workspaceId))
    .from(p)
    .innerJoin(candidates, eq(candidates.id, p.candidateId))
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);

  const ids = rows.map((row) => row.candidateId);
  const matches = await matchesFor(viewer.workspaceId, ids);
  const total = countRow?.total ?? 0;
  return {
    total,
    limit,
    offset,
    nextOffset: offset + limit < total ? offset + limit : null,
    candidates: rows.map((row) =>
      toView(
        row as ProfileRow,
        matches.get(row.candidateId) ?? [],
        Boolean(filters.includeEvidence),
        viewer.appOrigin,
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export type TalentStats = {
  candidates: number;
  profiled: number;
  postings: {
    postingKey: string;
    postingLabel: string | null;
    scored: number;
    atLeast5: number;
    atLeast7: number;
    atLeast7NotContacted: number;
  }[];
  sourceChannels: { channel: string; candidates: number }[];
  weekly: { weekStart: string; newCandidates: number; profiled: number }[];
  keyCompanies: { company: string; candidates: number; atLeast7: number }[];
  roles: { role: string; candidates: number }[];
};

export async function talentStats(
  viewer: TalentViewer,
  options: { weeks?: number; top?: number } = {},
): Promise<TalentStats> {
  const weeks = Math.min(Math.max(Math.floor(options.weeks ?? 12), 1), 104);
  const top = Math.min(Math.max(Math.floor(options.top ?? 30), 1), 200);
  const p = candidateTalentProfiles;
  const m = candidateTalentMatches;
  const visible = activeCandidate(viewer);
  const contacted = contactedSql(viewer.workspaceId);

  const [totals] = await db
    .select({
      candidates: sql<number>`count(*)::int`,
      profiled: sql<number>`count(${p.id})::int`,
    })
    .from(candidates)
    .leftJoin(p, and(eq(p.candidateId, candidates.id), eq(p.workspaceId, viewer.workspaceId)))
    .where(visible);

  const postings = await db
    .select({
      postingKey: m.postingKey,
      postingLabel: sql<string | null>`max(${m.postingLabel})`,
      scored: sql<number>`count(*)::int`,
      atLeast5: sql<number>`count(*) filter (where ${m.score} >= 5)::int`,
      atLeast7: sql<number>`count(*) filter (where ${m.score} >= 7)::int`,
      atLeast7NotContacted: sql<number>`count(*) filter (where ${m.score} >= 7 and not ${contacted})::int`,
    })
    .from(m)
    .innerJoin(candidates, eq(candidates.id, m.candidateId))
    .where(and(eq(m.workspaceId, viewer.workspaceId), visible))
    .groupBy(m.postingKey)
    .orderBy(sql`count(*) filter (where ${m.score} >= 7) desc`, m.postingKey);

  const unnestCount = async (column: AnyPgColumn, limitRows: number) => {
    const result = await db.execute<{ value: string; candidates: number; at_least_7: number }>(sql`
      select tag.value as value, count(*)::int as candidates,
        count(*) filter (where ${p.bestScore} >= 7)::int as at_least_7
      from ${p}
      inner join ${candidates} on ${candidates.id} = ${p.candidateId}
      cross join lateral unnest(${column}) as tag(value)
      where ${p.workspaceId} = ${viewer.workspaceId} and ${visible}
      group by tag.value
      order by count(*) desc, tag.value asc
      limit ${limitRows}`);
    return (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  };

  const [channels, companies, roles] = await Promise.all([
    unnestCount(p.sourceChannels, 50),
    unnestCount(p.keyCompanies, top),
    unnestCount(p.roles, top),
  ]);

  const firstSeen = sql`coalesce(${p.firstContactAt}, ${candidates.createdAt})`;
  const weekly = await db.execute<{ week_start: string; new_candidates: number; profiled: number }>(sql`
    select to_char(date_trunc('week', ${firstSeen} at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as week_start,
      count(*)::int as new_candidates,
      count(${p.id})::int as profiled
    from ${candidates}
    left join ${p} on ${p.candidateId} = ${candidates.id} and ${p.workspaceId} = ${viewer.workspaceId}
    where ${visible}
      and ${firstSeen} >= date_trunc('week', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' - make_interval(weeks => ${weeks - 1})
    group by 1
    order by 1 asc`);
  const weeklyRows = (weekly as unknown as { rows?: unknown[] }).rows ?? (weekly as unknown as unknown[]);

  type Counted = { value: string; candidates: number; at_least_7: number };
  return {
    candidates: totals?.candidates ?? 0,
    profiled: totals?.profiled ?? 0,
    postings,
    sourceChannels: (channels as Counted[]).map((row) => ({ channel: row.value, candidates: Number(row.candidates) })),
    weekly: (weeklyRows as { week_start: string; new_candidates: number; profiled: number }[]).map((row) => ({
      weekStart: row.week_start,
      newCandidates: Number(row.new_candidates),
      profiled: Number(row.profiled),
    })),
    keyCompanies: (companies as Counted[]).map((row) => ({
      company: row.value,
      candidates: Number(row.candidates),
      atLeast7: Number(row.at_least_7),
    })),
    roles: (roles as Counted[]).map((row) => ({ role: row.value, candidates: Number(row.candidates) })),
  };
}
