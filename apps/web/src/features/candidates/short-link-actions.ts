"use server";

import { z } from "zod";

import {
  cleanDirectoryFilters,
  DIRECTORY_FILTER_KEYS,
  type DirectoryOriginFilters,
} from "@/features/candidates/origin";
import { expandDirectoryRoleAliases, listDirectoryJobRefs } from "@/features/candidates/job-refs";
import {
  createCandidateList,
  ensureCandidateListShortId,
  findFilterListBySpec,
  getCandidateList,
} from "@/features/candidates/lists";
import { readableFilterTitle } from "@/features/candidates/short-links";
import { requirePermission } from "@/features/workspaces/permissions-server";

const filterValue = z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]);
const inputSchema = z.object(
  Object.fromEntries(DIRECTORY_FILTER_KEYS.map((key) => [key, filterValue.optional()])) as Record<
    (typeof DIRECTORY_FILTER_KEYS)[number],
    z.ZodOptional<typeof filterValue>
  >,
);

export type SaveDirectoryFilterResult =
  | { success: true; shortId: string; title: string; created: boolean }
  | { success: false; error: string };

/**
 * "Copy short link": saves the current directory filters as a list (once;
 * the same filters reuse the same list) and returns its short id, which
 * `/v/<shortId>` opens. A filter that already is a saved list returns that
 * list's id.
 */
export async function saveDirectoryFilterAction(
  input: Partial<Record<(typeof DIRECTORY_FILTER_KEYS)[number], string | string[]>>,
): Promise<SaveDirectoryFilterResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "invalid_filters" };
  const context = await requirePermission("candidates:view");
  const workspaceId = context.organization.id;

  const cleaned = cleanDirectoryFilters(parsed.data);

  if (cleaned.list) {
    const list = await getCandidateList(workspaceId, String(cleaned.list));
    if (!list) return { success: false, error: "list_not_found" };
    const withId = await ensureCandidateListShortId(list);
    return { success: true, shortId: withId.shortId!, title: withId.title, created: false };
  }

  // Page and view params are not filters; a spec of nothing is not worth saving.
  const spec: DirectoryOriginFilters = await expandDirectoryRoleAliases(cleaned);
  if (Object.keys(spec).length === 0) return { success: false, error: "no_filters" };

  const existing = await findFilterListBySpec(workspaceId, spec);
  if (existing) {
    const withId = await ensureCandidateListShortId(existing);
    return { success: true, shortId: withId.shortId!, title: withId.title, created: false };
  }

  const jobs = await listDirectoryJobRefs();
  const title = readableFilterTitle(spec, {
    jobTitleById: Object.fromEntries(jobs.map((job) => [job.id, job.title])),
  });
  const created = await createCandidateList({
    workspaceId,
    createdById: context.user.id,
    title,
    mode: "filter",
    filterSpec: spec,
  });
  return { success: true, shortId: created.shortId!, title: created.title, created: true };
}
