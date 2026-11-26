import type { TalentSearchFilters, TalentSort } from "./service";

/** Split a comma-separated query value ("a,b" or "a，b") into trimmed items. */
export function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const bool = (value: string | undefined) =>
  value === "true" ? true : value === "false" ? false : undefined;

export type TalentSearchQuery = Partial<
  Record<
    | "q"
    | "skills"
    | "roles"
    | "companies"
    | "keyCompanies"
    | "industries"
    | "workKinds"
    | "sourceChannels"
    | "education"
    | "city"
    | "posting"
    | "contacted"
    | "jobId"
    | "firstContactAfter"
    | "firstContactBefore"
    | "lastActiveAfter"
    | "lastActiveBefore"
    | "sort"
    | "includeEvidence",
    string
  >
> &
  Partial<Record<"minYears" | "maxYears" | "minScore" | "limit" | "offset", number>>;

/** Map the REST query string to service filters. */
export function talentFiltersFromQuery(query: TalentSearchQuery): TalentSearchFilters {
  return {
    query: query.q,
    skills: splitList(query.skills),
    roles: splitList(query.roles),
    companies: splitList(query.companies),
    keyCompanies: splitList(query.keyCompanies),
    industries: splitList(query.industries),
    workKinds: splitList(query.workKinds),
    sourceChannels: splitList(query.sourceChannels),
    education: splitList(query.education),
    city: query.city,
    minYears: query.minYears,
    maxYears: query.maxYears,
    postingKey: query.posting,
    minScore: query.minScore,
    contacted: bool(query.contacted),
    jobId: query.jobId,
    firstContactAfter: query.firstContactAfter,
    firstContactBefore: query.firstContactBefore,
    lastActiveAfter: query.lastActiveAfter,
    lastActiveBefore: query.lastActiveBefore,
    sort: query.sort as TalentSort | undefined,
    limit: query.limit,
    offset: query.offset,
    includeEvidence: bool(query.includeEvidence),
  };
}
