/**
 * Short, readable links for candidate directory filters. Pure and client-safe.
 *
 *   /c/<code>?days=14&source=boss   a job's short code (or slug) plus extra filters
 *   /dashboard/candidates?role=<code>   the same code accepted in `role`
 *   /v/<shortId>                    a saved filter ("复制短链")
 *
 * Every short form resolves to exactly the long `/dashboard/candidates?...`
 * filters, so the same people are listed whichever link was shared.
 */

import {
  buildCandidatesDirectoryUrl,
  cleanDirectoryFilters,
  filterValues,
  isShortId,
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  singleFilterValue,
  type DirectoryFilterKey,
  type DirectoryFilterValue,
  type DirectoryOriginFilters,
} from "@/features/candidates/origin";

const SHORT_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { isShortId };

/** A new random short id (7 chars from a 31 letter alphabet: ~2.7e10 values). */
export function generateShortId(random: (max: number) => number = randomIndex): string {
  let out = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i += 1) {
    out += SHORT_ID_ALPHABET[random(SHORT_ID_ALPHABET.length)];
  }
  return out;
}

function randomIndex(max: number): number {
  const cryptoApi = globalThis.crypto;
  // Rejection sampling keeps the alphabet uniform.
  const limit = 256 - (256 % max);
  const buf = new Uint8Array(1);
  for (;;) {
    cryptoApi.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

/**
 * Normalises a job short code: lower case, letters/digits/hyphens, 2-40 chars.
 * Returns null for anything else (and for UUID look-alikes, which mean job ids).
 */
export function normalizeShortCode(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const value = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-");
  if (!SHORT_CODE_PATTERN.test(value) || UUID.test(value)) return null;
  return value;
}

export type DirectoryJobRef = {
  id: string;
  title: string;
  slug: string;
  shortCode: string | null;
};

/** The job a code names: short codes win over slugs. Case-insensitive. */
export function findJobByCode(jobs: DirectoryJobRef[], code: string): DirectoryJobRef | undefined {
  const needle = code.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    jobs.find((job) => job.shortCode?.toLowerCase() === needle) ??
    jobs.find((job) => job.slug.toLowerCase() === needle)
  );
}

/**
 * Replaces `role` values that are a job short code or slug with that job's
 * title, which is what the directory filters on. A value that already is a job
 * title stays as it is, and so does anything unknown (it simply matches no one,
 * as before).
 */
export function expandRoleAliases<T extends DirectoryOriginFilters>(
  filters: T,
  jobs: DirectoryJobRef[],
): T {
  const roles = filterValues(filters.role);
  if (roles.length === 0) return filters;
  const titles = new Set(jobs.map((job) => job.title));
  const expanded: string[] = [];
  for (const role of roles) {
    const job = titles.has(role) ? undefined : findJobByCode(jobs, role);
    const next = job ? job.title : role;
    if (!expanded.includes(next)) expanded.push(next);
  }
  return { ...filters, role: expanded.length === 1 ? expanded[0]! : expanded };
}

/** The code to show for a job: its short code, else its slug. */
export function jobDisplayCode(job: Pick<DirectoryJobRef, "slug" | "shortCode">): string {
  return job.shortCode || job.slug;
}

/**
 * `/c/<code>?...` for a filter set that is one job title (plus other filters),
 * or null when the filters name no single job with a code (several titles,
 * a saved list, job ids…). `jobs` are the jobs the viewer can see.
 */
export function buildJobShortUrl(
  origin: string,
  filters: Partial<Record<DirectoryFilterKey, DirectoryFilterValue | null | undefined>>,
  jobs: DirectoryJobRef[],
): string | null {
  const cleaned = cleanDirectoryFilters(filters);
  if (cleaned.list || cleaned.jobId) return null;
  const roles = filterValues(cleaned.role);
  if (roles.length !== 1) return null;
  const matching = jobs.filter((job) => job.title === roles[0]);
  const withCode = matching.filter((job) => job.shortCode);
  // A title shared by several jobs would resolve to only one of them.
  if (withCode.length !== 1 || matching.length !== 1) return null;
  const code = withCode[0]!.shortCode!;
  const rest: DirectoryOriginFilters = { ...cleaned };
  delete rest.role;
  const long = buildCandidatesDirectoryUrl("", rest);
  const query = long.includes("?") ? long.slice(long.indexOf("?")) : "";
  const base = origin ? origin.replace(/\/+$/, "") : "";
  return `${base}/c/${encodeURIComponent(code)}${query}`;
}

export function buildSavedFilterShortUrl(origin: string, shortId: string): string {
  const base = origin ? origin.replace(/\/+$/, "") : "";
  return `${base}/v/${encodeURIComponent(shortId)}`;
}

const SOURCE_LABELS: Record<string, string> = {
  boss: "BOSS",
  linkedin: "LinkedIn",
  lark: "Lark",
  referral: "内推",
};

const STATUS_LABELS_ZH: Record<string, string> = {
  active: "进行中",
  hired: "已录用",
  rejected: "已淘汰",
  withdrawn: "已撤回",
};

const CJK = /[\u3400-\u9fff]/;

export type FilterTitleInput = {
  /** Job titles by id, to name `jobId` filters. */
  jobTitleById?: Record<string, string>;
  /** Force the label language; default follows the filter values. */
  lang?: "zh" | "en";
};

/**
 * Human title for a filter set, e.g. 「游戏剧情策划实习 · BOSS · 近14天」.
 * Used for saved filters and for link text in messages.
 */
export function readableFilterTitle(
  filters: Partial<Record<DirectoryFilterKey, DirectoryFilterValue | null | undefined>>,
  input: FilterTitleInput = {},
): string {
  const f = cleanDirectoryFilters(filters);
  const jobNames = [
    ...filterValues(f.role),
    ...filterValues(f.jobId).map((id) => input.jobTitleById?.[id] ?? ""),
  ].filter(Boolean);
  const depts = filterValues(f.dept);
  const one = (key: DirectoryFilterKey) => singleFilterValue(f[key]);
  const tag = one("tag");
  const q = one("q");
  const stage = one("stage");
  const source = one("source");
  const status = one("status");
  const days = one("days");
  const after = one("appliedAfter");
  const before = one("appliedBefore");
  const text = [...jobNames, ...depts, q, stage, source, tag].filter(Boolean).join(" ");
  const zh = input.lang ? input.lang === "zh" : CJK.test(text);

  const parts: string[] = [];
  if (jobNames.length > 0) parts.push(jobNames.join(zh ? "、" : ", "));
  else if (depts.length > 0) parts.push(depts.join(zh ? "、" : ", "));
  if (q) parts.push(zh ? `搜索「${q}」` : `search "${q}"`);
  if (stage) parts.push(stage);
  if (source) parts.push(SOURCE_LABELS[source.toLowerCase()] ?? source);
  if (tag) parts.push(zh ? `标签 ${tag}` : `tag ${tag}`);
  if (status) parts.push(zh ? STATUS_LABELS_ZH[status] ?? status : status);
  if (days && !after) parts.push(zh ? `近${days}天` : `last ${days} days`);
  if (after || before) {
    const from = after?.slice(0, 10);
    const to = before?.slice(0, 10);
    if (from && to) parts.push(`${from} ~ ${to}`);
    else if (from) parts.push(zh ? `${from} 起` : `from ${from}`);
    else if (to) parts.push(zh ? `${to} 前` : `until ${to}`);
  }
  if (one("hasResume")) parts.push(zh ? "有简历" : "with resume");
  return parts.length > 0 ? parts.join(" · ") : zh ? "全部候选人" : "All candidates";
}
