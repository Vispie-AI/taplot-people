import { z } from "zod";

/**
 * First-pass AI resume screens written by the screening engine (Talent Amy's
 * Opus screen). Pure and client-safe: the API route and tests share it.
 * A screen is a suggestion for reviewers; it never moves a candidate.
 */

export const SCREENING_VERDICTS = ["strong", "maybe", "no"] as const;
export type ScreeningVerdict = (typeof SCREENING_VERDICTS)[number];

export const MAX_SCREENINGS_PER_REQUEST = 100;

const text = (max: number) => z.string().trim().min(1).max(max);

const criterion = z
  .object({
    label: text(200),
    result: z.enum(["yes", "part", "no", "unknown"]),
    quote: z.string().trim().max(400).optional(),
  })
  .strict();

export const aiScreeningItemSchema = z
  .object({
    /** The Harly candidate, when the engine knows it. */
    candidateId: z.uuid().optional(),
    /** Source record the screen was made on (a BOSS import's `sourceRecordId`); resolved to the candidate here. */
    sourceRecordId: text(64).optional(),
    /** The engine's id of the job (a Lark Base record id). */
    sourceJobId: text(64),
    verdict: z.enum(SCREENING_VERDICTS),
    reason: z.string().trim().max(600).optional(),
    criteria: z.array(criterion).max(30).default([]),
    model: z.string().trim().max(120).optional(),
    screenedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((item) => item.candidateId || item.sourceRecordId, {
    message: "Send candidateId or sourceRecordId.",
  });

export const aiScreeningsRequestSchema = z
  .object({ items: z.array(aiScreeningItemSchema).min(1).max(MAX_SCREENINGS_PER_REQUEST) })
  .strict();

export type AiScreeningItem = z.output<typeof aiScreeningItemSchema>;
export type AiScreeningsRequest = z.input<typeof aiScreeningsRequestSchema>;

/** `YYYY-MM-DD` means that day in Asia/Shanghai (the recruiting team's calendar); anything else is parsed as an instant. */
export function parseScreeningTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+08:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
