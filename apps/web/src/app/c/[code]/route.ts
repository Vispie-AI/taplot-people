import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { listDirectoryJobRefs } from "@/features/candidates/job-refs";
import { findJobByCode } from "@/features/candidates/short-links";
import { requirePagePermission } from "@/features/workspaces/permissions-server";

export const dynamic = "force-dynamic";

/**
 * `/c/<job short code or slug>?days=14&source=boss` opens the candidate
 * directory for that job. It redirects to `/dashboard/candidates` with
 * `role=<job title>` and every other query param untouched, so the people
 * listed are exactly those of the long link.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  await requirePagePermission("candidates:view");
  const jobs = await listDirectoryJobRefs();
  const job = findJobByCode(jobs, decodeURIComponent(code));
  if (!job) notFound();
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.delete("role");
  params.delete("jobId");
  params.set("role", job.title);
  redirect(`/dashboard/candidates?${params.toString()}` as Route);
}
