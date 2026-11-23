import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight, CheckCircle2, ClipboardCheck, Trash2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";

import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { UserAvatar } from "@/components/ui/UserAvatar";
import {
  CandidatesTable,
  type CandidateRow,
} from "@/features/candidates/CandidatesTable";
import {
  ImportCandidatesDrawer,
  type ImportSource,
} from "@/features/candidates/import/ImportCandidatesDrawer";
import {
  listCandidateDirectory,
  listCandidateDirectoryFacets,
  listTrashedCandidates,
  type CandidateDirectoryFilters,
} from "@/features/candidates/data";
import { originFiltersToDirectoryFilters } from "@/features/candidates/directory-query";
import { getCandidateList } from "@/features/candidates/lists";
import { DirectoryTabs, PageTitleRow } from "@/features/candidates/directory-chrome";
import { TrashCandidateActions } from "@/features/candidates/TrashCandidateActions";
import { AddCandidateDrawer } from "@/features/candidates/AddCandidateDrawer";
import { listEmailTemplates } from "@/features/email-templates/data";
import { listJobOptions } from "@/features/jobs/data";
import { listWorkspaceMembers } from "@/features/jobs/hiring-team-data";
import { isUnrestrictedScope } from "@/features/search/scope";
import { resolveSearchActor } from "@/features/search/workspace-search";
import { getReviewQueue } from "@/features/review/queue";
import { ReviewQueueList } from "@/features/review/ReviewQueueList";
import {
  candidateHref,
  directoryOrigin,
  filterValues,
  REVIEW_ORIGIN,
  singleFilterValue,
} from "@/features/candidates/origin";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { can, getRolePolicy, requirePagePermission } from "@/features/workspaces/permissions-server";
import { candidateAvatarFallbackSrcs } from "@/lib/candidate-avatar";
import { getWorkspaceGravatarEnabled } from "@/lib/gravatar";
import { formatRelative, formatShort } from "@/lib/date";

export const dynamic = "force-dynamic";

function appliedLabel(value: Date, locale: string) {
  const days = Math.abs(Date.now() - value.getTime()) / 86_400_000;
  return days < 30 ? formatRelative(value, locale) : formatShort(value, locale);
}

type CandidatesPageProps = {
  searchParams: Promise<{
    view?: string;
    import?: string;
    q?: string;
    dept?: string | string[];
    role?: string | string[];
    jobId?: string | string[];
    stage?: string;
    status?: string;
    source?: string;
    tag?: string;
    appliedAfter?: string;
    appliedBefore?: string;
    days?: string;
    hasResume?: string;
    list?: string;
    sort?: string;
    page?: string;
    /** `review`: the current user's review queue instead of the directory. */
    queue?: string;
    /** Set by auto-advance after the last queue item. */
    done?: string;
  }>;
};

export default async function CandidatesPage({ searchParams }: CandidatesPageProps) {
  const t = await getTranslations("candidates.directory");
  const locale = await getLocale();
  await requirePagePermission("candidates:view");
  const rawParams = await searchParams;
  const { view, import: importSource, page: pageRaw, queue, done } = rawParams;
  const isQueue = queue === "review";
  const isTrash = !isQueue && view === "trash";
  const initialImportSource: ImportSource | undefined =
    importSource === "csv" ||
    importSource === "greenhouse" ||
    importSource === "workable" ||
    importSource === "ashby" ||
    importSource === "lever" ||
    importSource === "join"
      ? importSource
      : undefined;

  const parsedOrigin = directoryOrigin(rawParams);
  const urlFilters = parsedOrigin.kind === "candidates" ? parsedOrigin.filters : {};
  const mappedFilters = originFiltersToDirectoryFilters(urlFilters);

  const directoryFilters: CandidateDirectoryFilters = {
    ...mappedFilters,
    page: Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1,
    pageSize: 50,
  };
  const hasActiveUrlFilters = Object.keys(urlFilters).length > 0;
  const workspaceContext = await getWorkspaceContext();
  const policy = await getRolePolicy(workspaceContext.organization.id, workspaceContext.roleKey);
  const [
    directory,
    facets,
    activeList,
    reviewQueue,
    trashed,
    emailTemplates,
    jobOptions,
    members,
    canCreateCandidates,
    canReject,
    canDelete,
    canExport,
  ] = await Promise.all([
    isQueue
      ? Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 50, hasNextPage: false })
      : listCandidateDirectory(directoryFilters),
    isQueue
      ? Promise.resolve({ departments: [], roles: [], stages: [], sources: [], tags: [] })
      : listCandidateDirectoryFacets(),
    !isQueue && !isTrash && mappedFilters.listId
      ? getCandidateList(workspaceContext.organization.id, mappedFilters.listId)
      : Promise.resolve(null),
    // The same source Home counts, so "Review queue · N" matches it.
    resolveSearchActor().then((actor) => getReviewQueue(actor)),
    // The trash is not filtered by job scope, so a role limited to specific jobs
    // does not load it (its names and emails cannot be scoped per candidate here).
    isUnrestrictedScope(policy.scope) ? listTrashedCandidates() : Promise.resolve([]),
    listEmailTemplates(),
    listJobOptions(),
    listWorkspaceMembers(),
    can("candidates:edit"),
    can("candidates:reject"),
    can("candidates:delete"),
    can("candidates:export"),
  ]);
  const gravatarEnabled = await getWorkspaceGravatarEnabled(workspaceContext.organization.id);

  const rows: CandidateRow[] = directory.rows.map((candidate) => {
    const applied = candidate.latestApplication?.appliedAt ?? null;
    return {
      id: candidate.id,
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      avatarUrl: candidate.avatarUrl,
      avatarFallbackSrcs: candidateAvatarFallbackSrcs(candidate.email, candidate.githubUrl, { gravatarEnabled }),
      inPool: candidate.inPool,
      hasResume: Boolean(candidate.hasResume),
      hasOpenPrivacyRequest: candidate.hasOpenPrivacyRequest,
      isReferred: candidate.isReferred,
      isFeaturedReferral: candidate.isFeaturedReferral,
      location: candidate.location,
      headline: candidate.headline ?? null,
      role: candidate.latestApplication?.jobTitle ?? null,
      department: candidate.latestApplication?.department ?? null,
      stage: candidate.latestApplication?.currentStageName ?? null,
      status: candidate.latestApplication?.status ?? null,
      source: candidate.latestApplication?.source ?? null,
      tags: candidate.tags,
      appliedAt: applied ? applied.getTime() : null,
      appliedLabel: applied ? appliedLabel(applied, locale) : null,
      applicationId: candidate.latestApplication?.applicationId ?? null,
      updatedAt: candidate.updatedAt.getTime(),
    };
  });

  const QUEUE_LIST_LIMIT = 100;
  const queueItems = reviewQueue.items.slice(0, QUEUE_LIST_LIMIT);
  const firstQueueItem = reviewQueue.items[0] ?? null;

  const importJobsProp = jobOptions.map((job) => ({ id: job.id, title: job.title }));
  const jobNamesById = Object.fromEntries(jobOptions.map((job) => [job.id, job.title]));
  const selectedDepts = filterValues(urlFilters.dept);
  const selectedRoles = filterValues(urlFilters.role);
  const selectedJobIds = filterValues(urlFilters.jobId);

  return (
    <div className="space-y-6">
      <PageTitleRow
        title={isQueue ? t("reviewQueueTitle", { count: reviewQueue.total }) : t("title")}
        description={
          isQueue
            ? t("reviewQueueDescription")
            : undefined
        }
      >
        {isQueue && firstQueueItem ? (
          <Button asChild>
            <Link href={candidateHref(firstQueueItem.candidateId, REVIEW_ORIGIN, firstQueueItem.applicationId) as Route}>
              {t("startReviewing")}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        ) : null}
        {isQueue ? null : (
          <ImportCandidatesDrawer jobs={importJobsProp} initialSource={initialImportSource} />
        )}
        {canCreateCandidates && !isQueue ? (
          <AddCandidateDrawer
            workspaceId={workspaceContext.organization.id}
            jobs={importJobsProp}
            members={members}
            currentUserId={workspaceContext.user.id}
          />
        ) : null}
      </PageTitleRow>

      <DirectoryTabs
        label={t("views")}
        items={[
          { href: "/dashboard/candidates", label: t("all"), count: isQueue ? undefined : directory.total, active: !isTrash && !isQueue },
          {
            href: "/dashboard/candidates?queue=review",
            label: t("reviewQueue"),
            count: reviewQueue.total,
            icon: <ClipboardCheck className="size-3.5" aria-hidden />,
            active: isQueue,
          },
          {
            href: "/dashboard/candidates?view=trash",
            label: t("trash"),
            count: trashed.length,
            icon: <Trash2 className="size-3.5" aria-hidden />,
            active: isTrash,
          },
        ]}
      />

      {isQueue ? (
        reviewQueue.total === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={t("queueCleared")}
            description={t("queueClearedDescription")}
            action={{ href: "/dashboard", label: t("backHome") }}
            secondaryAction={
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/candidates">{t("allCandidates")}</Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {done === "1" ? (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-inner)] bg-sage-wash px-4 py-3 text-[14px] text-near-ink"
              >
                <span>
                  {t("queueDone", { count: reviewQueue.total })}
                </span>
                <Link href="/dashboard" className="font-medium underline-offset-4 hover:underline">
                  {t("backHome")}
                </Link>
              </div>
            ) : null}
            <ReviewQueueList items={queueItems} />
            {reviewQueue.items.length > queueItems.length ? (
              <p className="text-center text-[13px] text-soft-ink">
                {t("queueLimitHint", { shown: queueItems.length, total: reviewQueue.total })}
              </p>
            ) : null}
          </div>
        )
      ) : isTrash ? (
        trashed.length > 0 ? (
          <Card className="gap-0 divide-y divide-hairline overflow-hidden py-0">
            {trashed.map((candidate) => (
              <div
                key={candidate.id}
                className="flex min-h-[60px] items-center justify-between gap-3 px-5 py-3"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <UserAvatar
                    name={candidate.fullName}
                    src={null}
                    fallbackSrcs={candidateAvatarFallbackSrcs(candidate.email, candidate.githubUrl, { gravatarEnabled })}
                    size="lg"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[14.5px] font-medium text-soft-ink">
                      {candidate.fullName}
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-soft-ink">
                      {t("deletedAt", { date: formatRelative(candidate.deletedAt, locale) })}
                    </span>
                  </span>
                </span>
                <TrashCandidateActions
                  candidateId={candidate.id}
                  candidateName={candidate.fullName}
                />
              </div>
            ))}
          </Card>
        ) : (
          <EmptyState
            icon={Trash2}
            title={t("trashEmpty")}
            description={t("trashEmptyDescription")}
          />
        )
      ) : rows.length === 0 && !hasActiveUrlFilters ? (
        <EmptyState
          icon={Users}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={
            canCreateCandidates ? (
              <AddCandidateDrawer
                workspaceId={workspaceContext.organization.id}
                jobs={importJobsProp}
                members={members}
                currentUserId={workspaceContext.user.id}
              />
            ) : undefined
          }
          secondaryAction={
            <ImportCandidatesDrawer jobs={importJobsProp} initialSource={initialImportSource} />
          }
        />
      ) : (
        <div className="space-y-4">
          {activeList ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-inner)] border border-hairline bg-card-inset px-4 py-3 text-[13.5px] text-near-ink"
            >
              <div className="min-w-0">
                <p className="font-medium text-near-ink">{activeList.title}</p>
                {activeList.description ? (
                  <p className="mt-0.5 text-[12.5px] text-soft-ink">{activeList.description}</p>
                ) : null}
              </div>
              <Button asChild variant="outline" size="sm" className="rounded-full">
                <Link href="/dashboard/candidates">{t("allCandidates")}</Link>
              </Button>
            </div>
          ) : null}
          <CandidatesTable
            key={JSON.stringify(directoryFilters)}
            rows={rows}
            pageInfo={{ page: directory.page, pageSize: directory.pageSize, total: directory.total, hasNextPage: directory.hasNextPage }}
            filterOptions={facets}
            jobNamesById={jobNamesById}
            initialFilters={{
              query: singleFilterValue(urlFilters.q) ?? "",
              dept: selectedDepts.length === 1 ? selectedDepts[0]! : "__all__",
              depts: selectedDepts,
              role: selectedRoles.length === 1 ? selectedRoles[0]! : "__all__",
              roles: selectedRoles,
              jobIds: selectedJobIds,
              stage: singleFilterValue(urlFilters.stage) ?? "__all__",
              status: mappedFilters.status ?? "__all__",
              source: singleFilterValue(urlFilters.source) ?? "__all__",
              tag: singleFilterValue(urlFilters.tag) ?? "__all__",
              appliedAfter: singleFilterValue(urlFilters.appliedAfter) ?? "",
              appliedBefore: singleFilterValue(urlFilters.appliedBefore) ?? "",
              days: singleFilterValue(urlFilters.days) ?? "__all__",
              hasResume: mappedFilters.hasResume ?? false,
              list: mappedFilters.listId ?? "",
              sort: mappedFilters.sort ?? "recent",
            }}
            emailTemplates={emailTemplates}
            access={{ canReject, canDelete, canExport }}
          />
        </div>
      )}
    </div>
  );
}
