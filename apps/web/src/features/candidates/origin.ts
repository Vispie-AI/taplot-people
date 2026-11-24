/**
 * Where a candidate page was opened from, carried in its URL so the pager
 * (previous / next) walks that same list and "Back" returns to it with its
 * filters. Pure and client-safe: the only place these params are encoded or
 * decoded, so links, the pager and the server page cannot drift apart.
 *
 *   Review queue   /dashboard/candidates/<id>?queue=review&application=<appId>
 *   Directory      /dashboard/candidates/<id>?from=candidates&q=ana&stage=Interview
 *                  (no params at all = the unfiltered directory)
 *   Pipeline       /dashboard/candidates/<id>?from=pipeline&jobId=<job>&stage=<stageId>&q=ana&view=board&application=<appId>
 */

export const DIRECTORY_FILTER_KEYS = [
  "q",
  "dept",
  "role",
  "jobId",
  "stage",
  "status",
  "source",
  "tag",
  "appliedAfter",
  "appliedBefore",
  "days",
  "hasResume",
  "list",
  "sort",
] as const;
export type DirectoryFilterKey = (typeof DIRECTORY_FILTER_KEYS)[number];
export type DirectoryMultiFilterKey = "dept" | "role" | "jobId";
export type DirectoryFilterValue = string | string[];
export type DirectoryOriginFilters = Partial<Record<DirectoryFilterKey, DirectoryFilterValue>>;

const DIRECTORY_MULTI_KEYS = new Set<DirectoryFilterKey>(["dept", "role", "jobId"]);
const DIRECTORY_STATUSES = ["active", "hired", "rejected", "withdrawn"] as const;
/** "recent" is the directory default, so it is never written to the URL. */
const DIRECTORY_SORTS = ["oldest", "modified", "name"] as const;

export type CandidateOrigin =
  | { kind: "review" }
  | { kind: "candidates"; filters: DirectoryOriginFilters }
  | {
      kind: "pipeline";
      jobId: string;
      /** Stage id the list was filtered to. */
      stage?: string;
      q?: string;
      view?: "board";
    };

export type PipelineOrigin = Extract<CandidateOrigin, { kind: "pipeline" }>;

export type CandidateNavigation = {
  origin: CandidateOrigin;
  /** The application the origin row stood for (queue and pipeline rows). */
  applicationId: string | null;
};

export const REVIEW_ORIGIN: CandidateOrigin = { kind: "review" };
export const DIRECTORY_ORIGIN: CandidateOrigin = { kind: "candidates", filters: {} };

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

const MAX_TEXT = 100;
const MAX_MULTI = 50;
/** "__all__" and friends are UI sentinels for "no filter", never values. */
const SENTINEL = /^__.*__$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Alphabet of saved-filter short ids (`/v/<id>`): no 0/1/i/l/o. */
export const SHORT_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const SHORT_ID_LENGTH = 7;
const SHORT_ID_PATTERN = new RegExp(`^[${SHORT_ID_ALPHABET}]{${SHORT_ID_LENGTH}}$`);

export function isShortId(value: string | null | undefined): value is string {
  return typeof value === "string" && SHORT_ID_PATTERN.test(value);
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function read(params: ParamSource, key: string): string | undefined {
  if (!params) return undefined;
  const raw =
    params instanceof URLSearchParams
      ? params.get(key)
      : (() => {
          const value = params[key];
          return Array.isArray(value) ? value[0] : value;
        })();
  return raw ?? undefined;
}

function readAll(params: ParamSource, key: string): string[] {
  if (!params) return [];
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function cleanText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT);
  if (!trimmed || SENTINEL.test(trimmed)) return undefined;
  return trimmed;
}

function cleanId(value: string | null | undefined): string | undefined {
  const text = cleanText(value);
  return text && UUID.test(text) ? text : undefined;
}

function cleanDateBound(value: string | null | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  if (ISO_DATE_ONLY.test(text)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : text;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function cleanDays(value: string | null | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || !/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? String(n) : undefined;
}

function cleanHasResume(value: string | null | undefined): string | undefined {
  const text = cleanText(value)?.toLowerCase();
  return text === "1" || text === "true" ? "1" : undefined;
}

/** Normalize a single or multi-value filter entry to an array of non-empty strings. */
export function filterValues(value: DirectoryFilterValue | null | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Single-value accessor for filters that hold at most one value. */
export function singleFilterValue(value: DirectoryFilterValue | null | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

/**
 * Resolve `appliedAfter`, `appliedBefore`, and `days` into inclusive UTC Date
 * bounds for database queries. Date-only strings (`YYYY-MM-DD`) span the full
 * UTC calendar day (`00:00:00.000Z` through `23:59:59.999Z`).
 */
export function resolveAppliedDateRange(
  input: {
    appliedAfter?: string | Date | null;
    appliedBefore?: string | Date | null;
    days?: number | string | null;
  },
  now = new Date(),
): { appliedAfter?: Date; appliedBefore?: Date } {
  let appliedAfter: Date | undefined;
  let appliedBefore: Date | undefined;

  if (input.appliedAfter instanceof Date && !Number.isNaN(input.appliedAfter.getTime())) {
    appliedAfter = input.appliedAfter;
  } else if (typeof input.appliedAfter === "string") {
    const bound = cleanDateBound(input.appliedAfter);
    if (bound) {
      appliedAfter = new Date(ISO_DATE_ONLY.test(bound) ? `${bound}T00:00:00.000Z` : bound);
    }
  }

  if (input.appliedBefore instanceof Date && !Number.isNaN(input.appliedBefore.getTime())) {
    appliedBefore = input.appliedBefore;
  } else if (typeof input.appliedBefore === "string") {
    const bound = cleanDateBound(input.appliedBefore);
    if (bound) {
      appliedBefore = new Date(ISO_DATE_ONLY.test(bound) ? `${bound}T23:59:59.999Z` : bound);
    }
  }

  if (!appliedAfter && input.days != null) {
    const parsedDays = typeof input.days === "number" ? Math.trunc(input.days) : Number(cleanDays(String(input.days)));
    if (Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365) {
      appliedAfter = new Date(now.getTime() - parsedDays * 86_400_000);
    }
  }

  return { appliedAfter, appliedBefore };
}

function cleanMultiList(
  raw: DirectoryFilterValue | null | undefined,
  validator: (item: string) => string | undefined,
  splitCommas = false,
): DirectoryFilterValue | undefined {
  const items = filterValues(raw)
    .flatMap((entry) => (splitCommas ? entry.split(",") : [entry]))
    .map((entry) => validator(entry))
    .filter((entry): entry is string => Boolean(entry));
  const unique = Array.from(new Set(items)).slice(0, MAX_MULTI);
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0] : unique;
}

/** Keeps only meaningful directory filters, in a canonical form. */
export function cleanDirectoryFilters(
  input: Partial<Record<DirectoryFilterKey, DirectoryFilterValue | null | undefined>>,
): DirectoryOriginFilters {
  const filters: DirectoryOriginFilters = {};
  for (const key of DIRECTORY_FILTER_KEYS) {
    const raw = input[key];
    if (raw == null) continue;
    if (key === "jobId") {
      const cleaned = cleanMultiList(raw, cleanId, true);
      if (cleaned) filters.jobId = cleaned;
      continue;
    }
    if (key === "dept" || key === "role") {
      const cleaned = cleanMultiList(raw, cleanText, false);
      if (cleaned) filters[key] = cleaned;
      continue;
    }
    const single = singleFilterValue(raw);
    if (key === "appliedAfter" || key === "appliedBefore") {
      const cleaned = cleanDateBound(single);
      if (cleaned) filters[key] = cleaned;
      continue;
    }
    if (key === "days") {
      const cleaned = cleanDays(single);
      if (cleaned) filters.days = cleaned;
      continue;
    }
    if (key === "hasResume") {
      const cleaned = cleanHasResume(single);
      if (cleaned) filters.hasResume = cleaned;
      continue;
    }
    if (key === "list") {
      // A saved filter is named by its UUID or by its short id (`/v/<id>`).
      const text = cleanText(single);
      if (text && (UUID.test(text) || isShortId(text.toLowerCase()))) {
        filters.list = text.toLowerCase();
      }
      continue;
    }
    const value = cleanText(single);
    if (!value) continue;
    if (key === "status" && !(DIRECTORY_STATUSES as readonly string[]).includes(value)) continue;
    if (key === "sort" && !(DIRECTORY_SORTS as readonly string[]).includes(value)) continue;
    filters[key] = value;
  }
  return filters;
}

/** Directory origin from the candidates page's own params (or filter state). */
export function directoryOrigin(
  input: ParamSource | Partial<Record<DirectoryFilterKey, DirectoryFilterValue | null | undefined>>,
): CandidateOrigin {
  const values: Partial<Record<DirectoryFilterKey, DirectoryFilterValue | undefined>> = {};
  for (const key of DIRECTORY_FILTER_KEYS) {
    if (DIRECTORY_MULTI_KEYS.has(key)) {
      if (input instanceof URLSearchParams) {
        const all = readAll(input, key);
        values[key] = all.length > 1 ? all : all[0];
      } else if (input) {
        const raw = (input as Record<string, DirectoryFilterValue | undefined>)[key];
        values[key] = raw;
      }
    } else {
      values[key] =
        input instanceof URLSearchParams
          ? read(input, key)
          : read(input as Record<string, string | string[] | undefined>, key);
    }
  }
  return { kind: "candidates", filters: cleanDirectoryFilters(values) };
}

export function pipelineOrigin(input: {
  jobId: string;
  stage?: string | null;
  q?: string | null;
  view?: string | null;
}): PipelineOrigin {
  const origin: PipelineOrigin = {
    kind: "pipeline",
    jobId: input.jobId,
  };
  const stage = cleanId(input.stage);
  const q = cleanText(input.q);
  if (stage) origin.stage = stage;
  if (q) origin.q = q;
  if (input.view === "board") origin.view = "board";
  return origin;
}

/** Decodes a candidate page's search params. Unknown or bad input = directory. */
export function parseCandidateNavigation(params: ParamSource): CandidateNavigation {
  const applicationId = cleanId(read(params, "application")) ?? null;

  if (read(params, "queue") === "review") {
    return { origin: REVIEW_ORIGIN, applicationId };
  }

  if (read(params, "from") === "pipeline") {
    const jobId = cleanId(read(params, "jobId"));
    if (jobId) {
      return {
        origin: pipelineOrigin({
          jobId,
          stage: read(params, "stage"),
          q: read(params, "q"),
          view: read(params, "view"),
        }),
        applicationId,
      };
    }
    return { origin: DIRECTORY_ORIGIN, applicationId };
  }

  if (read(params, "from") === "candidates") {
    return { origin: directoryOrigin(params), applicationId };
  }

  return { origin: DIRECTORY_ORIGIN, applicationId };
}

function appendDirectoryFilters(params: URLSearchParams, filters: DirectoryOriginFilters) {
  for (const key of DIRECTORY_FILTER_KEYS) {
    const raw = filters[key];
    if (!raw) continue;
    for (const value of filterValues(raw)) {
      params.append(key, value);
    }
  }
}

/** The origin (and optional application) as a candidate page query string. */
export function candidateNavigationParams(
  origin: CandidateOrigin,
  applicationId?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  const application = cleanId(applicationId);
  switch (origin.kind) {
    case "review":
      params.set("queue", "review");
      if (application) params.set("application", application);
      break;
    case "pipeline":
      params.set("from", "pipeline");
      params.set("jobId", origin.jobId);
      if (origin.stage) params.set("stage", origin.stage);
      if (origin.q) params.set("q", origin.q);
      if (origin.view) params.set("view", origin.view);
      if (application) params.set("application", application);
      break;
    case "candidates": {
      const filters = cleanDirectoryFilters(origin.filters);
      const keys = DIRECTORY_FILTER_KEYS.filter((key) => filters[key]);
      // The unfiltered directory is the default origin: keep its links bare.
      if (keys.length === 0) break;
      params.set("from", "candidates");
      appendDirectoryFilters(params, filters);
      break;
    }
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Canonical relative or absolute `/dashboard/candidates` URL for a filter set. */
export function buildCandidatesDirectoryUrl(
  origin: string,
  filters: Partial<Record<DirectoryFilterKey, DirectoryFilterValue | null | undefined>>,
): string {
  const cleaned = cleanDirectoryFilters(filters);
  const params = new URLSearchParams();
  appendDirectoryFilters(params, cleaned);
  const base = origin ? `${origin.replace(/\/+$/, "")}/dashboard/candidates` : "/dashboard/candidates";
  return withQuery(base, params);
}

/** A candidate's page, opened from `origin`. */
export function candidateHref(
  candidateId: string,
  origin: CandidateOrigin = DIRECTORY_ORIGIN,
  applicationId?: string | null,
): string {
  return withQuery(
    `/dashboard/candidates/${encodeURIComponent(candidateId)}`,
    candidateNavigationParams(origin, applicationId),
  );
}

/** Where "Back" goes: the origin list, with its filters. */
export function originHref(origin: CandidateOrigin): string {
  switch (origin.kind) {
    case "review":
      return "/dashboard/candidates?queue=review";
    case "pipeline": {
      const params = new URLSearchParams({ jobId: origin.jobId });
      if (origin.view) params.set("view", origin.view);
      if (origin.stage) params.set("stage", origin.stage);
      if (origin.q) params.set("q", origin.q);
      return withQuery("/dashboard/pipeline", params);
    }
    case "candidates": {
      const filters = cleanDirectoryFilters(origin.filters);
      const params = new URLSearchParams();
      appendDirectoryFilters(params, filters);
      return withQuery("/dashboard/candidates", params);
    }
  }
}

/** Translator for `labels.candidates.origin`. */
export type OriginTranslator = (key: string) => string;

/** Short name of the origin list, for "3 of 12 in …" and "Back to …". */
export function originLabel(origin: CandidateOrigin, t: OriginTranslator): string {
  switch (origin.kind) {
    case "review":
      return t("review");
    case "pipeline":
      return t("pipeline");
    case "candidates":
      return Object.keys(cleanDirectoryFilters(origin.filters)).length > 0
        ? t("filteredCandidates")
        : t("candidates");
  }
}

export function originBackLabel(origin: CandidateOrigin, t: OriginTranslator): string {
  switch (origin.kind) {
    case "review":
      return t("backToReview");
    case "pipeline":
      return t("backToPipeline");
    case "candidates":
      return t("backToCandidates");
  }
}
