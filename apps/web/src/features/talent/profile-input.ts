import { z } from "zod";

/**
 * Talent profile written by an external tagging engine. Pure and client-safe:
 * the API route and tests share it. Every tag value must be backed by at least
 * one evidence quote from the source text, so a reader can check why a
 * candidate carries a tag without opening the resume. Age, birth date, gender
 * and other protected traits are deliberately not part of the profile.
 */

export const TALENT_LIST_FIELDS = [
  "skills",
  "roles",
  "companies",
  "keyCompanies",
  "industries",
] as const;
export type TalentListField = (typeof TALENT_LIST_FIELDS)[number];

export const TALENT_EVIDENCE_FIELDS = [
  ...TALENT_LIST_FIELDS,
  "works",
  "city",
  "experienceYears",
  "education",
] as const;

export const EDUCATION_LEVELS = [
  "博士",
  "硕士",
  "本科",
  "大专",
  "高中及以下",
  "未知",
] as const;

export const WORK_KINDS = [
  "爆款素材",
  "游戏作品",
  "短剧作品",
  "App产品",
  "开源",
  "论文",
  "其他",
] as const;

export const MATCH_TIERS = ["目标", "达标", "边缘", "错配"] as const;

/** Matches at or above this score must quote their evidence. */
export const MATCH_EVIDENCE_MIN_SCORE = 5;

const label = z.string().trim().min(1).max(120);
const quote = z.string().trim().min(1).max(300);
const isoDate = z.iso.datetime({ offset: true });

const evidenceItem = z
  .object({
    field: z.enum(TALENT_EVIDENCE_FIELDS),
    value: z.string().trim().max(200).optional(),
    quote,
  })
  .strict();

const workItem = z
  .object({
    kind: z.enum(WORK_KINDS),
    title: label,
    metric: z.string().trim().max(200).optional(),
  })
  .strict();

const matchItem = z
  .object({
    postingKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,63}$/, "postingKey must be snake_case"),
    postingLabel: z.string().trim().max(120).optional(),
    jobId: z.uuid().nullable().optional(),
    score: z.number().int().min(0).max(10),
    tier: z.enum(MATCH_TIERS).optional(),
    reason: z.string().trim().max(300).optional(),
    evidence: z.array(z.object({ quote }).strict()).max(10).default([]),
  })
  .strict();

const labels = z.array(label).max(50).default([]);

export const talentProfileInputSchema = z
  .object({
    tagVersion: z.string().trim().min(1).max(40),
    engine: z.string().trim().min(1).max(60),
    model: z.string().trim().max(120).optional(),
    inputHash: z.string().trim().max(128).optional(),
    taggedAt: isoDate.optional(),
    city: z.string().trim().max(80).nullable().optional(),
    experienceYears: z.number().int().min(0).max(60).nullable().optional(),
    education: z.enum(EDUCATION_LEVELS).nullable().optional(),
    skills: labels,
    roles: labels,
    companies: labels,
    keyCompanies: labels,
    industries: labels,
    sourceChannels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    works: z.array(workItem).max(30).default([]),
    firstContactAt: isoDate.nullable().optional(),
    lastActiveAt: isoDate.nullable().optional(),
    evidence: z.array(evidenceItem).max(200).default([]),
    matches: z.array(matchItem).max(50).default([]),
  })
  .strict();

export type TalentProfileInput = z.input<typeof talentProfileInputSchema>;
export type TalentProfileParsed = z.output<typeof talentProfileInputSchema>;

export type NormalizedTalentProfile = Omit<TalentProfileParsed, "taggedAt"> & {
  taggedAt: string;
  workKinds: string[];
  bestPostingKey: string | null;
  bestScore: number | null;
};

const fold = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = fold(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.normalize("NFKC").trim());
  }
  return out;
}

export class TalentProfileValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Talent profile is invalid: ${issues.slice(0, 5).join("; ")}`);
    this.name = "TalentProfileValidationError";
  }
}

/**
 * Parse, normalise and check evidence coverage. Throws
 * {@link TalentProfileValidationError} listing every tag without a quote.
 */
export function normalizeTalentProfile(
  raw: unknown,
  now: Date = new Date(),
): NormalizedTalentProfile {
  const parsed = talentProfileInputSchema.parse(raw);
  const issues: string[] = [];

  const lists = Object.fromEntries(
    TALENT_LIST_FIELDS.map((field) => [field, dedupe(parsed[field])]),
  ) as Record<TalentListField, string[]>;

  const backed = new Set(
    parsed.evidence
      .filter((item) => item.value)
      .map((item) => `${item.field}\u0000${fold(item.value!)}`),
  );
  for (const field of TALENT_LIST_FIELDS) {
    for (const value of lists[field]) {
      if (!backed.has(`${field}\u0000${fold(value)}`)) {
        issues.push(`${field} "${value}" has no evidence quote`);
      }
    }
  }
  for (const work of parsed.works) {
    if (!backed.has(`works\u0000${fold(work.title)}`)) {
      issues.push(`works "${work.title}" has no evidence quote`);
    }
  }

  const matchesByKey = new Map<string, (typeof parsed.matches)[number]>();
  for (const match of parsed.matches) {
    if (matchesByKey.has(match.postingKey)) {
      issues.push(`matches has posting "${match.postingKey}" twice`);
      continue;
    }
    if (match.score >= MATCH_EVIDENCE_MIN_SCORE && match.evidence.length === 0) {
      issues.push(
        `match "${match.postingKey}" scores ${match.score} without an evidence quote`,
      );
    }
    matchesByKey.set(match.postingKey, match);
  }

  if (issues.length > 0) throw new TalentProfileValidationError(issues);

  const matches = [...matchesByKey.values()];
  const best = matches.reduce<(typeof matches)[number] | null>(
    (top, match) => (!top || match.score > top.score ? match : top),
    null,
  );

  return {
    ...parsed,
    ...lists,
    sourceChannels: dedupe(parsed.sourceChannels),
    taggedAt: parsed.taggedAt ?? now.toISOString(),
    matches,
    workKinds: dedupe(parsed.works.map((work) => work.kind)),
    bestPostingKey: best?.postingKey ?? null,
    bestScore: best?.score ?? null,
  };
}
