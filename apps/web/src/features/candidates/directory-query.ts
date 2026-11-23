import "server-only";

import {
  and,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  applications,
  candidateFiles,
  candidates,
  candidateTags,
  db,
  jobs,
  jobStages,
} from "@harly/db";
import {
  candidateScopeSql,
  jobScopeSql,
  type WorkspaceSearchActor,
} from "@/features/search/scope";
import {
  filterValues,
  resolveAppliedDateRange,
  singleFilterValue,
  type DirectoryOriginFilters,
} from "@/features/candidates/origin";
import { getCandidateList, type CandidateListRecord } from "@/features/candidates/lists";

export type CandidateApplicationStatus =
  | "active"
  | "hired"
  | "rejected"
  | "withdrawn";

export type CandidateDirectoryFilters = {
  query?: string;
  department?: string;
  departments?: string[];
  role?: string;
  roles?: string[];
  jobIds?: string[];
  stage?: string;
  status?: CandidateApplicationStatus;
  source?: string;
  tag?: string;
  appliedAfter?: Date | string;
  appliedBefore?: Date | string;
  days?: number;
  hasResume?: boolean;
  listId?: string;
  /** Explicit shortlist restriction (e.g. from a snapshot `candidate_lists` row). */
  candidateIds?: string[];
  sort?: "recent" | "oldest" | "modified" | "name";
  page?: number;
  pageSize?: number;
};

function mergeStrings(single?: string, many?: string[]): string[] {
  const out = [...(many ?? []), ...(single ? [single] : [])]
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

export function scopedJobIdsSubquery(actor: WorkspaceSearchActor) {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, actor.workspaceId),
        isNull(jobs.deletedAt),
        jobScopeSql(actor),
      ),
    );
}

export function scopedApplicationJobPredicate(actor: WorkspaceSearchActor) {
  if (!jobScopeSql(actor)) return undefined;
  return inArray(applications.jobId, scopedJobIdsSubquery(actor));
}

/** Convert canonical URL `DirectoryOriginFilters` into `CandidateDirectoryFilters`. */
export function originFiltersToDirectoryFilters(
  origin: DirectoryOriginFilters,
): CandidateDirectoryFilters {
  const departments = filterValues(origin.dept);
  const roles = filterValues(origin.role);
  const jobIds = filterValues(origin.jobId);
  const status = singleFilterValue(origin.status);
  const sort = singleFilterValue(origin.sort);
  const daysRaw = singleFilterValue(origin.days);
  const days = daysRaw ? Number(daysRaw) : undefined;

  return {
    query: singleFilterValue(origin.q),
    departments: departments.length > 0 ? departments : undefined,
    roles: roles.length > 0 ? roles : undefined,
    jobIds: jobIds.length > 0 ? jobIds : undefined,
    stage: singleFilterValue(origin.stage),
    status:
      status === "active" ||
      status === "hired" ||
      status === "rejected" ||
      status === "withdrawn"
        ? status
        : undefined,
    source: singleFilterValue(origin.source),
    tag: singleFilterValue(origin.tag),
    appliedAfter: singleFilterValue(origin.appliedAfter),
    appliedBefore: singleFilterValue(origin.appliedBefore),
    days: days && Number.isInteger(days) ? days : undefined,
    hasResume: singleFilterValue(origin.hasResume) === "1" ? true : undefined,
    listId: singleFilterValue(origin.list),
    sort:
      sort === "oldest" || sort === "modified" || sort === "name"
        ? sort
        : "recent",
  };
}

/**
 * If `filters.listId` is provided, load the saved list for this workspace and
 * merge its filter specification (or snapshot candidate IDs) into the filters.
 */
export async function resolveDirectoryListFilters(
  workspaceId: string,
  filters: CandidateDirectoryFilters,
): Promise<{
  filters: CandidateDirectoryFilters;
  activeList: CandidateListRecord | null;
}> {
  if (!filters.listId) return { filters, activeList: null };
  const list = await getCandidateList(workspaceId, filters.listId);
  if (!list) {
    // Unknown or expired list ID returns an empty result rather than leaking the full directory.
    return { filters: { ...filters, candidateIds: [] }, activeList: null };
  }
  if (list.mode === "snapshot") {
    return {
      filters: { ...filters, candidateIds: list.candidateIds },
      activeList: list,
    };
  }
  if (!list.filterSpec) {
    return { filters, activeList: list };
  }
  const base = originFiltersToDirectoryFilters(list.filterSpec);
  const merged: CandidateDirectoryFilters = {
    ...base,
    ...Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
    ),
    departments: mergeStrings(filters.department, filters.departments).length
      ? mergeStrings(filters.department, filters.departments)
      : base.departments,
    roles: mergeStrings(filters.role, filters.roles).length
      ? mergeStrings(filters.role, filters.roles)
      : base.roles,
    jobIds: filters.jobIds?.length ? filters.jobIds : base.jobIds,
    hasResume: filters.hasResume ?? base.hasResume,
    appliedAfter: filters.appliedAfter ?? base.appliedAfter,
    appliedBefore: filters.appliedBefore ?? base.appliedBefore,
    days: filters.days ?? base.days,
  };
  return { filters: merged, activeList: list };
}

/**
 * Shared SQL predicate builder used by both `listCandidateDirectory` and
 * `queue-neighbors.ts` (`rankedDirectory`), so directory pages, exports,
 * summaries, MCP searches, and prev/next candidate paging always agree.
 *
 * Unlike the old latest-application-only filter, job/department/stage/status/
 * source/date filters match ANY in-scope application of the candidate so
 * multi-job applicants are never silently dropped.
 */
export function buildCandidateDirectoryPredicates(
  actor: WorkspaceSearchActor,
  input: CandidateDirectoryFilters,
): SQL[] {
  const workspaceId = actor.workspaceId;
  const applicationScope = scopedApplicationJobPredicate(actor);
  const predicates: SQL[] = [
    eq(candidates.workspaceId, workspaceId),
    isNull(candidates.deletedAt),
  ];

  const visibleCandidate = candidateScopeSql(actor, candidates.id);
  if (visibleCandidate) predicates.push(visibleCandidate);

  if (input.candidateIds !== undefined) {
    if (input.candidateIds.length === 0) {
      predicates.push(sql`false`);
    } else {
      predicates.push(inArray(candidates.id, input.candidateIds));
    }
  }

  const query = input.query?.trim().replace(/\s+/g, " ").slice(0, 100) ?? "";
  if (query) {
    const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
    const like = `%${escapedQuery}%`;
    predicates.push(
      or(
        ilike(candidates.firstName, like),
        ilike(candidates.lastName, like),
        ilike(candidates.email, like),
        ilike(candidates.phone, like),
        ilike(candidates.headline, like),
        ilike(candidates.location, like),
        exists(
          db
            .select({ id: applications.id })
            .from(applications)
            .innerJoin(
              jobs,
              and(
                eq(jobs.id, applications.jobId),
                eq(jobs.workspaceId, workspaceId),
                isNull(jobs.deletedAt),
              ),
            )
            .where(
              and(
                eq(applications.workspaceId, workspaceId),
                eq(applications.candidateId, candidates.id),
                applicationScope,
                or(ilike(jobs.title, like), ilike(jobs.department, like)),
              ),
            ),
        ),
      )!,
    );
  }

  const departments = mergeStrings(input.department, input.departments);
  const roles = mergeStrings(input.role, input.roles);
  const jobIds = Array.from(new Set((input.jobIds ?? []).filter(Boolean)));
  const { appliedAfter, appliedBefore } = resolveAppliedDateRange({
    appliedAfter: input.appliedAfter,
    appliedBefore: input.appliedBefore,
    days: input.days,
  });

  const hasAppDimensionFilter =
    departments.length > 0 ||
    roles.length > 0 ||
    jobIds.length > 0 ||
    Boolean(input.stage) ||
    Boolean(input.status) ||
    Boolean(input.source);

  const hasDateFilter = Boolean(appliedAfter || appliedBefore);

  if (hasAppDimensionFilter) {
    const appPredicates: SQL[] = [
      eq(applications.workspaceId, workspaceId),
      eq(applications.candidateId, candidates.id),
    ];
    if (applicationScope) appPredicates.push(applicationScope);
    if (jobIds.length > 0) appPredicates.push(inArray(applications.jobId, jobIds));
    if (departments.length > 0) appPredicates.push(inArray(jobs.department, departments));
    if (roles.length > 0) appPredicates.push(inArray(jobs.title, roles));
    if (input.stage) appPredicates.push(eq(jobStages.name, input.stage));
    if (input.status) appPredicates.push(eq(applications.status, input.status));
    if (input.source) appPredicates.push(eq(applications.source, input.source));
    if (appliedAfter) appPredicates.push(gte(applications.appliedAt, appliedAfter));
    if (appliedBefore) appPredicates.push(lte(applications.appliedAt, appliedBefore));

    predicates.push(
      exists(
        db
          .select({ id: applications.id })
          .from(applications)
          .innerJoin(
            jobs,
            and(
              eq(jobs.id, applications.jobId),
              eq(jobs.workspaceId, workspaceId),
              isNull(jobs.deletedAt),
            ),
          )
          .leftJoin(
            jobStages,
            and(
              eq(jobStages.id, applications.currentStageId),
              eq(jobStages.workspaceId, workspaceId),
            ),
          )
          .where(and(...appPredicates)),
      ),
    );
  } else if (hasDateFilter) {
    const appDatePreds: SQL[] = [
      eq(applications.workspaceId, workspaceId),
      eq(applications.candidateId, candidates.id),
    ];
    if (applicationScope) appDatePreds.push(applicationScope);
    if (appliedAfter) appDatePreds.push(gte(applications.appliedAt, appliedAfter));
    if (appliedBefore) appDatePreds.push(lte(applications.appliedAt, appliedBefore));

    const candDatePreds: SQL[] = [];
    if (appliedAfter) candDatePreds.push(gte(candidates.createdAt, appliedAfter));
    if (appliedBefore) candDatePreds.push(lte(candidates.createdAt, appliedBefore));

    predicates.push(
      or(
        exists(
          db
            .select({ id: applications.id })
            .from(applications)
            .where(and(...appDatePreds)),
        ),
        and(...candDatePreds),
      )!,
    );
  }

  if (input.tag) {
    predicates.push(
      exists(
        db
          .select({ id: candidateTags.id })
          .from(candidateTags)
          .where(
            and(
              eq(candidateTags.workspaceId, workspaceId),
              eq(candidateTags.candidateId, candidates.id),
              eq(candidateTags.label, input.tag),
            ),
          ),
      ),
    );
  }

  if (input.hasResume) {
    predicates.push(
      exists(
        db
          .select({ id: candidateFiles.id })
          .from(candidateFiles)
          .where(
            and(
              eq(candidateFiles.workspaceId, workspaceId),
              eq(candidateFiles.candidateId, candidates.id),
            ),
          ),
      ),
    );
  }

  return predicates;
}
