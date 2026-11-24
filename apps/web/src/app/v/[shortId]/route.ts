import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { getCandidateList } from "@/features/candidates/lists";
import { isShortId } from "@/features/candidates/origin";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { requirePagePermission } from "@/features/workspaces/permissions-server";

export const dynamic = "force-dynamic";

/**
 * `/v/<short id>` opens a saved candidate filter (the "Copy short link"
 * button). It redirects to `/dashboard/candidates?list=<short id>`, which
 * applies the saved filter through the same code as the long `?list=<uuid>`
 * link.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ shortId: string }> },
) {
  const { shortId: raw } = await context.params;
  const shortId = decodeURIComponent(raw).toLowerCase();
  if (!isShortId(shortId)) notFound();
  await requirePagePermission("candidates:view");
  const workspace = await getWorkspaceContext();
  const list = await getCandidateList(workspace.organization.id, shortId);
  if (!list) notFound();
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.set("list", shortId);
  redirect(`/dashboard/candidates?${params.toString()}` as Route);
}
