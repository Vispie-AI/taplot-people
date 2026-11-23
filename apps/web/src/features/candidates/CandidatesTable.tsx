"use client";

import { useConfirm } from "@/components/ui/confirm-dialog";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { Route } from "next";
import {
  CheckCircle2,
  Download,
  FileText,
  Mail,
  MoreHorizontal,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  User,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "@/lib/notification-island/toast";

import {
  bulkTrashCandidatesAction,
  bulkUpdateCandidateStatusAction,
  exportCandidateDirectoryAction,
  trashCandidateAction,
} from "@/features/candidates/actions";
import { addToPoolAction, removeFromPoolAction } from "@/features/pool/actions";
import { bulkDecisionConfirmCopy } from "@/features/pipeline/confirmation";
import { toSafeCsv } from "@/lib/csv";
import { candidateHref, directoryOrigin } from "@/features/candidates/origin";
import { BulkEmailDrawer } from "@/features/candidates/BulkEmailDrawer";
import {
  RejectDialog,
  type RejectTarget,
} from "@/features/rejection-reasons/RejectDialog";
import type { EmailTemplateOption } from "@/features/candidates/EmailDrawer";
import type {
  ImportJobOption,
  ImportSource,
} from "@/features/candidates/import/ImportCandidatesDrawer";
import { ReferralBadge } from "@/features/candidates/referrals/ReferralBadge";
import type { WorkspaceMemberOption } from "@/features/jobs/hiring-team-data";
import { ApplicationStatusBadge } from "@/components/ui/StatusBadge";
import { PipelineSpine } from "@/components/ui/PipelineSpine";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { FILTER_ALL } from "@/components/ui/FilterPill";
import {
  BulkAction,
  BulkActionBar,
  DirectoryCard,
  FilterBar,
  FilterChip,
  FilterCountButton,
  SearchPill,
  TotalLine,
  dirTable,
  dirTd,
  dirTh,
  dirTr,
} from "@/features/candidates/directory-chrome";
import { BookmarkSimpleIcon } from "@/components/ui/icons/phosphor";
import { cn } from "@/lib/utils";

export type CandidateRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  headline?: string | null;
  location: string | null;
  avatarUrl: string | null;
  avatarFallbackSrcs: string[];
  role: string | null;
  department: string | null;
  stage: string | null;
  status: "active" | "hired" | "rejected" | "withdrawn" | null;
  source: string | null;
  tags: string[];
  /** Epoch millis for sorting (null when no application). */
  appliedAt: number | null;
  /** Pre-formatted label (computed server-side to avoid hydration drift). */
  appliedLabel: string | null;
  applicationId: string | null;
  /** Epoch millis of last candidate update. */
  updatedAt: number;
  inPool: boolean;
  /** Whether the candidate has at least one uploaded resume file. */
  hasResume?: boolean;
  /** Has a pending or in-progress data-export/erasure request awaiting review. */
  hasOpenPrivacyRequest: boolean;
  isReferred: boolean;
  isFeaturedReferral: boolean;
};

type SortKey = "recent" | "oldest" | "modified" | "name";

function uniqueSorted(values: (string | null)[]) {
  return Array.from(
    new Set(values.filter((v): v is string => Boolean(v))),
  ).sort((a, b) => a.localeCompare(b));
}

function candidateToCsvRow(row: CandidateRow): string[] {
  return [
    row.fullName,
    row.email,
    row.phone ?? "",
    row.location ?? "",
    row.role ?? "",
    row.department ?? "",
    row.stage ?? "",
    row.status ?? "",
    row.source ?? "",
    row.tags.join("; "),
    row.appliedAt ? new Date(row.appliedAt).toISOString().slice(0, 10) : "",
  ];
}

// Leading BOM helps Excel detect UTF-8 (accented names, etc.) on download.
const UTF8_BOM = String.fromCharCode(0xfeff);

function downloadCsv(filename: string, rows: string[][]) {
  const csv = toSafeCsv(rows);
  const blob = new Blob([UTF8_BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function CandidatesTable({
  rows,
  pageInfo,
  initialFilters,
  filterOptions,
  jobNamesById = {},
  emailTemplates = [],
  access,
}: {
  /** What the viewer may do. Omitted means everything (the server still checks). */
  access?: { canReject?: boolean; canDelete?: boolean; canExport?: boolean };
  rows: CandidateRow[];
  pageInfo?: { page: number; pageSize: number; total: number; hasNextPage: boolean };
  filterOptions?: {
    departments: string[];
    roles: string[];
    stages: string[];
    sources: string[];
    tags: string[];
  };
  jobNamesById?: Record<string, string>;
  initialFilters?: {
    query: string;
    dept: string;
    depts?: string[];
    role: string;
    roles?: string[];
    jobIds?: string[];
    stage: string;
    status: string;
    source: string;
    tag: string;
    appliedAfter?: string;
    appliedBefore?: string;
    days?: string;
    hasResume?: boolean;
    list?: string;
    sort: string;
  };
  emailTemplates?: EmailTemplateOption[];
  /** Rendered by the page title row now; accepted for call-site compatibility. */
  importJobs?: ImportJobOption[];
  initialImportSource?: ImportSource;
  manualCandidate?: {
    workspaceId: string;
    members: WorkspaceMemberOption[];
    currentUserId: string;
  };
}) {
  const t = useTranslations("candidates.table");
  const tConfirm = useTranslations("labels.pipeline.confirmation");
  const tx = useTranslations("features.candidates.candidatesTable");
  const router = useRouter();
  const canReject = access?.canReject !== false;
  const canDelete = access?.canDelete !== false;
  const canExport = access?.canExport !== false;
  const [query, setQuery] = useState(initialFilters?.query ?? "");
  const [sortKey, setSortKey] = useState<SortKey>((initialFilters?.sort as SortKey) ?? "recent");
  const [dept, setDept] = useState(initialFilters?.dept ?? FILTER_ALL);
  const [role, setRole] = useState(initialFilters?.role ?? FILTER_ALL);
  const [stage, setStage] = useState(initialFilters?.stage ?? FILTER_ALL);
  const [status, setStatus] = useState(initialFilters?.status ?? FILTER_ALL);
  const [source, setSource] = useState(initialFilters?.source ?? FILTER_ALL);
  const [tag, setTag] = useState(initialFilters?.tag ?? FILTER_ALL);
  const [days, setDays] = useState(initialFilters?.days ?? FILTER_ALL);
  const [hasResume, setHasResume] = useState(initialFilters?.hasResume ? "1" : FILTER_ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [rejectTargets, setRejectTargets] = useState<RejectTarget[]>([]);
  const [rejectFromBulk, setRejectFromBulk] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const confirm = useConfirm();
  const multiDepts = useMemo(() => initialFilters?.depts ?? [], [initialFilters?.depts]);
  const multiRoles = useMemo(() => initialFilters?.roles ?? [], [initialFilters?.roles]);
  const selectedJobIds = useMemo(() => initialFilters?.jobIds ?? [], [initialFilters?.jobIds]);
  const appliedAfter = initialFilters?.appliedAfter ?? "";
  const appliedBefore = initialFilters?.appliedBefore ?? "";
  const listId = initialFilters?.list ?? "";

  // Rows open the candidate with this list's URL filters, so the candidate
  // page's previous / next walk this list and "Back" restores it.
  const origin = useMemo(
    () =>
      directoryOrigin({
        q: initialFilters?.query,
        dept: multiDepts.length > 1 ? multiDepts : initialFilters?.dept,
        role: multiRoles.length > 1 ? multiRoles : initialFilters?.role,
        jobId: selectedJobIds.length > 0 ? selectedJobIds : undefined,
        stage: initialFilters?.stage,
        status: initialFilters?.status,
        source: initialFilters?.source,
        tag: initialFilters?.tag,
        appliedAfter: appliedAfter || undefined,
        appliedBefore: appliedBefore || undefined,
        days: initialFilters?.days,
        hasResume: initialFilters?.hasResume ? "1" : undefined,
        list: listId || undefined,
        sort: initialFilters?.sort,
      }),
    [initialFilters, multiDepts, multiRoles, selectedJobIds, appliedAfter, appliedBefore, listId],
  );

  function navigateWithFilter(key: string, value: string) {
    const params = new URLSearchParams(window.location.search);
    if (
      !value ||
      value === FILTER_ALL ||
      (key === "sort" && value === "recent") ||
      (key === "page" && value === "1")
    ) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    if (key === "days") {
      params.delete("appliedAfter");
      params.delete("appliedBefore");
    }
    if (key !== "page") {
      params.delete("page");
    }
    const queryString = params.toString();
    router.push(`/dashboard/candidates${queryString ? `?${queryString}` : ""}` as Route);
  }

  function removeUrlKeys(keys: string[]) {
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) params.delete(key);
    params.delete("page");
    const queryString = params.toString();
    router.push(`/dashboard/candidates${queryString ? `?${queryString}` : ""}` as Route);
  }

  const departments = useMemo(
    () => filterOptions?.departments ?? uniqueSorted(rows.map((r) => r.department)),
    [filterOptions?.departments, rows],
  );
  const roles = useMemo(() => filterOptions?.roles ?? uniqueSorted(rows.map((r) => r.role)), [filterOptions?.roles, rows]);
  const stages = useMemo(() => filterOptions?.stages ?? uniqueSorted(rows.map((r) => r.stage)), [filterOptions?.stages, rows]);
  const sources = useMemo(
    () => filterOptions?.sources ?? uniqueSorted(rows.map((r) => r.source)),
    [filterOptions?.sources, rows],
  );
  const tagOptions = useMemo(
    () => filterOptions?.tags ?? uniqueSorted(rows.flatMap((r) => r.tags)),
    [filterOptions?.tags, rows],
  );

  // Server-side `listCandidateDirectory` already applies all URL filters
  // (including multi-value dept/role/jobId, date bounds, hasResume, saved lists,
  // and non-latest-application matches). Only narrow live typing in the search
  // box when it diverges from the server query so valid server rows are never hidden.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const serverQ = (initialFilters?.query ?? "").trim().toLowerCase();
    const base =
      q && q !== serverQ
        ? rows.filter(
            (r) =>
              r.fullName.toLowerCase().includes(q) ||
              r.email.toLowerCase().includes(q) ||
              (r.role ?? "").toLowerCase().includes(q) ||
              (r.location ?? "").toLowerCase().includes(q),
          )
        : rows;

    return [...base].sort((a, b) => {
      if (sortKey === "name") return a.fullName.localeCompare(b.fullName);
      if (sortKey === "modified") return b.updatedAt - a.updatedAt;
      if (sortKey === "oldest") return (a.appliedAt ?? 0) - (b.appliedAt ?? 0);
      // "recent" , whichever happened last wins: new application OR last modified
      const aRecent = Math.max(a.appliedAt ?? 0, a.updatedAt);
      const bRecent = Math.max(b.appliedAt ?? 0, b.updatedAt);
      return bRecent - aRecent;
    });
  }, [rows, query, initialFilters?.query, sortKey]);

  const filtersActive =
    dept !== FILTER_ALL ||
    multiDepts.length > 0 ||
    role !== FILTER_ALL ||
    multiRoles.length > 0 ||
    selectedJobIds.length > 0 ||
    stage !== FILTER_ALL ||
    status !== FILTER_ALL ||
    source !== FILTER_ALL ||
    tag !== FILTER_ALL ||
    days !== FILTER_ALL ||
    Boolean(appliedAfter) ||
    Boolean(appliedBefore) ||
    hasResume !== FILTER_ALL ||
    Boolean(listId) ||
    query.trim() !== "";

  function clearFilters() {
    setQuery("");
    setDept(FILTER_ALL);
    setRole(FILTER_ALL);
    setStage(FILTER_ALL);
    setStatus(FILTER_ALL);
    setSource(FILTER_ALL);
    setTag(FILTER_ALL);
    setDays(FILTER_ALL);
    setHasResume(FILTER_ALL);
    router.push("/dashboard/candidates");
  }

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((r) => next.delete(r.id));
      else filtered.forEach((r) => next.add(r.id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulk(next: "hired" | "rejected" | "active") {
    const selectedRows = filtered.filter((r) => selected.has(r.id) && r.applicationId);
    const applicationIds = selectedRows.map((r) => r.applicationId as string);

    if (applicationIds.length === 0) {
      toast.error(tx("noApplicationSelected"));
      return;
    }
    // Every reject, one candidate or many, asks for a reason and an email
    // decision in RejectDialog.
    if (next === "rejected") {
      setRejectFromBulk(true);
      setRejectTargets(
        selectedRows.map((r) => ({
          applicationId: r.applicationId as string,
          candidateName: r.fullName,
          jobTitle: r.role,
        })),
      );
      setRejectOpen(true);
      return;
    }
    if (
      applicationIds.length > 1 &&
      next === "hired" &&
      !(await confirm(bulkDecisionConfirmCopy(tConfirm, next, applicationIds.length)))
    ) {
      return;
    }
    startTransition(async () => {
      const result = await bulkUpdateCandidateStatusAction({
        applicationIds,
        status: next,
      });
      if (result.success) {
        const message = tx("bulkUpdated", { count: applicationIds.length });
        if (result.emailWarning) {
          toast.warning(tx("withWarning", { message, warning: result.emailWarning }));
        } else {
          toast.success(message);
        }
        setSelected(new Set());
        router.refresh();
      } else {
        toast.error(result.error ?? tx("couldNotUpdateCandidates"));
      }
    });
  }

  function runRowStatus(
    row: CandidateRow,
    next: "hired" | "rejected" | "active",
  ) {
    if (!row.applicationId) {
      toast.error(tx("noApplicationForCandidate"));
      return;
    }
    if (next === "rejected") {
      setRejectFromBulk(false);
      setRejectTargets([
        {
          applicationId: row.applicationId,
          candidateName: row.fullName,
          jobTitle: row.role,
        },
      ]);
      setRejectOpen(true);
      return;
    }
    startTransition(async () => {
      const result = await bulkUpdateCandidateStatusAction({
        applicationIds: [row.applicationId as string],
        status: next,
      });
      if (result.success) {
        if (result.emailWarning) {
          toast.warning(tx("updatedWithWarning", { name: row.fullName, warning: result.emailWarning }));
        } else {
          toast.success(tx("updated", { name: row.fullName }));
        }
        router.refresh();
      } else {
        toast.error(result.error ?? tx("couldNotUpdateCandidate"));
      }
    });
  }

  async function runDelete(row: CandidateRow) {
    if (
      !(await confirm({
        tone: "destructive",
        title: tx("moveToTrashTitle", { name: row.fullName }),
        description: tx("trashDescription"),
        confirmLabel: tx("moveToTrash"),
      }))
    ) {
      return;
    }
    startTransition(async () => {
      const result = await trashCandidateAction(row.id);
      if (result.success) {
        toast.success(tx("movedToTrash", { name: row.fullName }));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        router.refresh();
      } else {
        toast.error(result.error ?? tx("couldNotDeleteCandidate"));
      }
    });
  }

  function runTogglePool(row: CandidateRow) {
    startTransition(async () => {
      const result = row.inPool
        ? await removeFromPoolAction({ candidateId: row.id })
        : await addToPoolAction({ candidateId: row.id, source: "sourced" });
      if (result.success) {
        toast.success(
          row.inPool
            ? tx("removedFromPool", { name: row.fullName })
            : tx("addedToPool", { name: row.fullName }),
        );
        router.refresh();
      } else {
        toast.error(
          result.error ??
            (row.inPool
              ? tx("couldNotRemoveFromPool")
              : tx("couldNotAddToPool")),
        );
        router.refresh();
      }
    });
  }

  async function runBulkDelete() {
    const ids = filtered.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    if (
      !(await confirm({
        tone: "destructive",
        title: tx("bulkTrashTitle", { count: ids.length }),
        description: tx("trashDescription"),
        confirmLabel: tx("bulkMoveToTrash", { count: ids.length }),
      }))
    ) {
      return;
    }
    startTransition(async () => {
      const result = await bulkTrashCandidatesAction(ids);
      if (result.success) {
        const count = result.count ?? ids.length;
        toast.success(tx("bulkMovedToTrash", { count }));
        setSelected(new Set());
        router.refresh();
      } else {
        toast.error(result.error ?? tx("couldNotDeleteCandidates"));
      }
    });
  }

  const selectedCount = filtered.filter((r) => selected.has(r.id)).length;

  function exportCsv() {
    const exportRows = filtered.filter((r) => selected.has(r.id));
    if (selectedCount > 0 && exportRows.length === 0) {
      toast.error(tx("noCandidatesToExport"));
      return;
    }
    if (selectedCount > 0) {
      downloadCsv(`candidates-${new Date().toISOString().slice(0, 10)}.csv`, [
        [t("fullName"), t("email"), t("phone"), t("location"), t("role"), t("department"), t("stage"), t("status"), t("source"), t("tags"), t("appliedAt")],
        ...exportRows.map(candidateToCsvRow),
      ]);
      return;
    }

    startTransition(async () => {
      const exportStatus =
        status === "active" ||
        status === "hired" ||
        status === "rejected" ||
        status === "withdrawn"
          ? status
          : undefined;
      const result = await exportCandidateDirectoryAction({
        query,
        department: dept === FILTER_ALL ? undefined : dept,
        departments: multiDepts.length > 0 ? multiDepts : undefined,
        role: role === FILTER_ALL ? undefined : role,
        roles: multiRoles.length > 0 ? multiRoles : undefined,
        jobIds: selectedJobIds.length > 0 ? selectedJobIds : undefined,
        stage: stage === FILTER_ALL ? undefined : stage,
        status: exportStatus,
        source: source === FILTER_ALL ? undefined : source,
        tag: tag === FILTER_ALL ? undefined : tag,
        appliedAfter: appliedAfter || undefined,
        appliedBefore: appliedBefore || undefined,
        days: days !== FILTER_ALL ? Number(days) : undefined,
        hasResume: hasResume === "1" ? true : undefined,
        listId: listId || undefined,
        sort: sortKey,
      });
      if (!result.success) {
        toast.error(result.error ?? tx("couldNotExportCandidates"));
        return;
      }
      const blob = new Blob([UTF8_BOM + result.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(tx("exported", { count: result.count }));
    });
  }

  const total = pageInfo?.total ?? filtered.length;
  const activeFilterCount =
    [dept, role, stage, status, source, tag, days, hasResume].filter(
      (v) => v !== FILTER_ALL,
    ).length +
    (multiDepts.length > 1 ? 1 : 0) +
    (multiRoles.length > 1 ? 1 : 0) +
    (selectedJobIds.length > 0 ? 1 : 0) +
    (appliedAfter || appliedBefore ? 1 : 0) +
    (listId ? 1 : 0);

  const activeRangeLabel =
    appliedAfter && appliedBefore
      ? `${appliedAfter.slice(0, 10)} ~ ${appliedBefore.slice(0, 10)}`
      : appliedAfter
        ? `>= ${appliedAfter.slice(0, 10)}`
        : appliedBefore
          ? `<= ${appliedBefore.slice(0, 10)}`
          : "";

  const selectedJobLabels = selectedJobIds.map((id) => jobNamesById[id] ?? id.slice(0, 8));

  return (
    <>
      <DirectoryCard>
        <FilterBar>
          <SearchPill
            value={query}
            onChange={setQuery}
            onSubmit={() => navigateWithFilter("q", query.trim())}
            placeholder={t("searchPlaceholder")}
            label={t("searchLabel")}
          />
          <FilterCountButton count={activeFilterCount} onClear={clearFilters} />
          <FilterChip
            label={t("department")}
            value={dept}
            onChange={(value) => { setDept(value); navigateWithFilter("dept", value); }}
            options={departments}
          />
          <FilterChip
            label={t("job")}
            value={role}
            onChange={(value) => { setRole(value); navigateWithFilter("role", value); }}
            options={roles}
          />
          <FilterChip
            label={t("stage")}
            value={stage}
            onChange={(value) => { setStage(value); navigateWithFilter("stage", value); }}
            options={stages}
          />
          <FilterChip
            label={t("status")}
            value={status}
            onChange={(value) => { setStatus(value); navigateWithFilter("status", value); }}
            options={["active", "hired", "rejected", "withdrawn"]}
            labelMap={{
              active: t("active"),
              hired: t("hired"),
              rejected: t("rejected"),
              withdrawn: t("withdrawn"),
            }}
          />
          <FilterChip
            label={t("applied")}
            value={days}
            onChange={(value) => { setDays(value); navigateWithFilter("days", value); }}
            options={["7", "30", "90"]}
            labelMap={{
              "7": "7d",
              "30": "30d",
              "90": "90d",
            }}
          />
          <FilterChip
            label="Resume"
            value={hasResume}
            onChange={(value) => { setHasResume(value); navigateWithFilter("hasResume", value); }}
            options={["1"]}
            labelMap={{ "1": "Has resume" }}
          />
          {sources.length > 0 ? (
            <FilterChip
              label={t("source")}
              value={source}
              onChange={(value) => { setSource(value); navigateWithFilter("source", value); }}
              options={sources}
            />
          ) : null}
          {tagOptions.length > 0 ? (
            <FilterChip
              label={t("tag")}
              value={tag}
              onChange={(value) => { setTag(value); navigateWithFilter("tag", value); }}
              options={tagOptions}
            />
          ) : null}
          <FilterChip
            label={t("sort")}
            showValue
            value={sortKey}
            onChange={(v) => { setSortKey(v as SortKey); navigateWithFilter("sort", v); }}
            options={["recent", "oldest", "modified", "name"]}
            labelMap={{
              recent: t("mostRecent"),
              oldest: t("oldest"),
              modified: t("lastModified"),
              name: t("nameAZ"),
            }}
            allValue="recent"
          />
          {canExport ? (
            <Button
              variant="soft"
              className="ml-auto h-9 rounded-full"
              onClick={exportCsv}
              disabled={isPending}
            >
              <Download className="size-4" />
              {selectedCount > 0 ? t("exportSelected", { count: selectedCount }) : t("exportCsv")}
            </Button>
          ) : null}
        </FilterBar>

        {(activeRangeLabel || multiDepts.length > 1 || multiRoles.length > 1 || selectedJobIds.length > 0) ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-5 py-2.5 text-[12px]">
            {activeRangeLabel ? (
              <button
                type="button"
                onClick={() => removeUrlKeys(["appliedAfter", "appliedBefore"])}
                className="inline-flex items-center gap-1.5 rounded-full bg-card-inset px-2.5 py-1 font-medium text-near-ink hover:bg-muted"
              >
                <span>{t("applied")}: {activeRangeLabel}</span>
                <X className="size-3 text-soft-ink" />
              </button>
            ) : null}
            {multiDepts.length > 1 ? (
              <button
                type="button"
                onClick={() => removeUrlKeys(["dept"])}
                className="inline-flex items-center gap-1.5 rounded-full bg-card-inset px-2.5 py-1 font-medium text-near-ink hover:bg-muted"
              >
                <span>{t("department")}: {multiDepts.join(", ")}</span>
                <X className="size-3 text-soft-ink" />
              </button>
            ) : null}
            {multiRoles.length > 1 ? (
              <button
                type="button"
                onClick={() => removeUrlKeys(["role"])}
                className="inline-flex items-center gap-1.5 rounded-full bg-card-inset px-2.5 py-1 font-medium text-near-ink hover:bg-muted"
              >
                <span>{t("job")}: {multiRoles.join(", ")}</span>
                <X className="size-3 text-soft-ink" />
              </button>
            ) : null}
            {selectedJobLabels.length > 0 ? (
              <button
                type="button"
                onClick={() => removeUrlKeys(["jobId"])}
                className="inline-flex items-center gap-1.5 rounded-full bg-card-inset px-2.5 py-1 font-medium text-near-ink hover:bg-muted"
              >
                <span>{t("job")}: {selectedJobLabels.slice(0, 4).join(", ")}{selectedJobLabels.length > 4 ? ` +${selectedJobLabels.length - 4}` : ""}</span>
                <X className="size-3 text-soft-ink" />
              </button>
            ) : null}
          </div>
        ) : null}

        <TotalLine
          total={total}
          noun={tx("nounSingular")}
          pluralNoun={tx("nounPlural")}
          trailing={
            pageInfo && (pageInfo.page > 1 || pageInfo.hasNextPage) ? (
              <div className="flex items-center gap-2">
                  <span className="hidden tabular-nums sm:inline">{t("page", { page: pageInfo.page })}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={pageInfo.page <= 1 || isPending}
                  onClick={() => navigateWithFilter("page", String(pageInfo.page - 1))}
                >{t("previous")}</Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={!pageInfo.hasNextPage || isPending}
                  onClick={() => navigateWithFilter("page", String(pageInfo.page + 1))}
                >{t("next")}</Button>
              </div>
            ) : null
          }
        />

        {filtered.length > 0 ? (
          <div className="relative overflow-x-auto">
            <table className={dirTable}>
              <thead>
                <tr>
                  <th scope="col" className={cn(dirTh, "w-12")}>
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAll}
                      aria-label={t("selectAll")}
                    />
                  </th>
                  <th scope="col" className={dirTh}>{t("candidate")}</th>
                  <th scope="col" className={cn(dirTh, "hidden md:table-cell")}>{t("department")}</th>
                  <th scope="col" className={cn(dirTh, "hidden md:table-cell")}>{t("stage")}</th>
                  <th scope="col" className={cn(dirTh, "hidden lg:table-cell")}>{t("applied")}</th>
                  <th scope="col" className={dirTh}>{t("status")}</th>
                  <th scope="col" className={cn(dirTh, "w-14")}>
                    <span className="sr-only">{t("actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const isSelected = selected.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      data-state={isSelected ? "selected" : undefined}
                      className={dirTr}
                    >
                      <td className={dirTd}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(row.id)}
                          aria-label={`Select ${row.fullName}`}
                        />
                      </td>

                      <td className={cn(dirTd, "max-w-[360px] py-2")}>
                        <Link
                          href={candidateHref(row.id, origin) as Route}
                          className="flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-near-ink"
                        >
                          <UserAvatar
                            name={row.fullName}
                            src={row.avatarUrl}
                            fallbackSrcs={row.avatarFallbackSrcs}
                            size="lg"
                          />
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                              <p className="truncate text-[14.5px] font-medium text-near-ink group-hover/row:underline">
                                {row.fullName}
                              </p>
                              {row.hasResume ? (
                                <span
                                  title="Resume attached"
                                  className="inline-flex items-center gap-0.5 rounded-full bg-card-inset px-1.5 py-0.5 text-[11px] font-medium text-soft-ink"
                                >
                                  <FileText className="size-3" aria-hidden />
                                  CV
                                </span>
                              ) : null}
                              {row.inPool ? (
                                <StatusPill tone="warning" size="sm" icon={BookmarkSimpleIcon}>
                                  {t("inPool")}
                                </StatusPill>
                              ) : null}
                              {row.isReferred ? (
                                <ReferralBadge featured={row.isFeaturedReferral} />
                              ) : null}
                              {row.hasOpenPrivacyRequest ? (
                                <span title={t("pendingPrivacyRequest") }>
                                  <StatusPill tone="warning" size="sm" icon={ShieldAlert}>
                                    {t("privacyRequest")}
                                  </StatusPill>
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-[13px] text-soft-ink">
                              {[row.role ?? row.headline, row.location].filter(Boolean).join(" · ") ||
                                (row.email.endsWith("@boss.invalid") ? "" : row.email)}
                            </p>
                            {row.tags.length > 0 ? (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                                {row.tags.slice(0, 3).map((t) => (
                                  <span
                                    key={t}
                                    className="rounded-full bg-card-inset px-2 py-0.5 font-medium text-soft-ink"
                                  >
                                    {t}
                                  </span>
                                ))}
                                {row.tags.length > 3 ? (
                                  <span className="text-soft-ink">
                                    +{row.tags.length - 3}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </Link>
                      </td>

                      <td className={cn(dirTd, "hidden text-near-ink md:table-cell")}>
                        {row.department ?? <span className="text-quiet-mist">{t("none")}</span>}
                      </td>

                      <td className={cn(dirTd, "hidden md:table-cell")}>
                        {row.stage ? (
                          <>
                            <p className="text-[13px] font-medium text-near-ink">
                              {row.stage}
                            </p>
                            <PipelineSpine
                              current={row.stage}
                              className="mt-1.5 max-w-40"
                            />
                          </>
                        ) : (
                          <span className="text-[13px] text-quiet-mist">
                            {t("noApplication")}
                          </span>
                        )}
                      </td>

                      <td className={cn(dirTd, "hidden whitespace-nowrap text-[13px] text-soft-ink lg:table-cell")}>
                        {row.appliedLabel ?? <span className="text-quiet-mist">{t("none")}</span>}
                      </td>

                      <td className={dirTd}>
                        {row.status ? (
                          <ApplicationStatusBadge status={row.status} />
                        ) : (
                          <span className="text-quiet-mist">{t("none")}</span>
                        )}
                      </td>

                      <td className={dirTd}>
                        <RowActions
                          row={row}
                          disabled={isPending}
                          onView={() =>
                            router.push(candidateHref(row.id, origin) as Route)
                          }
                          onStatus={(next) => runRowStatus(row, next)}
                          onDelete={() => runDelete(row)}
                          canReject={canReject}
                          canDelete={canDelete}
                          onTogglePool={() => runTogglePool(row)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : filtersActive ? (
          <EmptyState
            variant="filtered"
            icon={Search}
            title={t("noMatches")}
            description={t("noMatchesDescription")}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("clearFilters")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Users}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            className="rounded-none border-0 bg-transparent"
          />
        )}
      </DirectoryCard>

      <BulkActionBar count={selectedCount} onClear={() => setSelected(new Set())}>
        <BulkAction disabled={isPending} onClick={() => setBulkEmailOpen(true)}>
          <Mail />
          {t("email")}
        </BulkAction>
        <BulkAction disabled={isPending} onClick={() => runBulk("hired")}>
          <CheckCircle2 />
          {t("markHired")}
        </BulkAction>
        {canReject ? (
          <BulkAction disabled={isPending} onClick={() => runBulk("rejected")}>
            <XCircle />
            {t("reject")}
          </BulkAction>
        ) : null}
        <BulkAction disabled={isPending} onClick={() => runBulk("active")}>
          <RotateCcw />
          {t("reactivate")}
        </BulkAction>
        {canDelete ? (
          <BulkAction danger disabled={isPending} onClick={runBulkDelete}>
            <Trash2 />
            {t("delete")}
          </BulkAction>
        ) : null}
      </BulkActionBar>

      <BulkEmailDrawer
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        candidateIds={filtered
          .filter((r) => selected.has(r.id))
          .map((r) => r.id)}
        templates={emailTemplates}
        onSent={() => setSelected(new Set())}
      />

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        targets={rejectTargets}
        onRejected={() => {
          if (rejectFromBulk) setSelected(new Set());
        }}
      />
    </>
  );
}

function RowActions({
  row,
  disabled,
  onView,
  onStatus,
  onDelete,
  canReject,
  canDelete,
  onTogglePool,
}: {
  canReject: boolean;
  canDelete: boolean;
  row: CandidateRow;
  disabled: boolean;
  onView: () => void;
  onStatus: (next: "hired" | "rejected" | "active") => void;
  onDelete: () => void;
  onTogglePool: () => void;
}) {
  const t = useTranslations("candidates.table");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-soft-ink"
          aria-label={t("actionsFor", { name: row.fullName })}
          disabled={disabled}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onView}>
          <User className="size-4" />
          {t("viewProfile")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onStatus("hired")}>
          <CheckCircle2 className="size-4 text-primary" />
          {t("markHired")}
        </DropdownMenuItem>
        {canReject ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onStatus("rejected")}
          >
            <XCircle className="size-4" />
          {t("reject")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onStatus("active")}>
          <RotateCcw className="size-4" />
          {t("reactivate")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePool}>
          <BookmarkSimpleIcon
            className={cn("size-4", row.inPool && "fill-current")}
          />
          {row.inPool ? t("removeFromPool") : t("addToPool")}
        </DropdownMenuItem>
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
