import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db, jobs } from "@harly/db";
import { jobScopeSql, type WorkspaceSearchActor } from "@/features/search/scope";
import { resolveSearchActor } from "@/features/search/workspace-search";
import {
  expandRoleAliases,
  type DirectoryJobRef,
} from "@/features/candidates/short-links";
import type { DirectoryOriginFilters } from "@/features/candidates/origin";

/** The jobs this actor can see, with the codes short links use. */
export async function listDirectoryJobRefs(
  actor?: WorkspaceSearchActor,
): Promise<DirectoryJobRef[]> {
  const who = actor ?? (await resolveSearchActor());
  return db
    .select({
      id: jobs.id,
      title: jobs.title,
      slug: jobs.slug,
      shortCode: jobs.shortCode,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, who.workspaceId),
        isNull(jobs.deletedAt),
        jobScopeSql(who),
      ),
    );
}

/** `role=<short code>` becomes `role=<job title>`; everything else is untouched. */
export async function expandDirectoryRoleAliases<T extends DirectoryOriginFilters>(
  filters: T,
  actor?: WorkspaceSearchActor,
): Promise<T> {
  if (!filters.role) return filters;
  return expandRoleAliases(filters, await listDirectoryJobRefs(actor));
}
