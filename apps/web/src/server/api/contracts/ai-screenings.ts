import { z } from "zod";

import {
  aiScreeningsRequestSchema,
  SCREENING_VERDICTS,
} from "@/features/ai-screenings/input";

import { defineContract } from "./core";
import { errorEnvelopeSchema, successEnvelopeSchema } from "./types";

const screeningSchema = z.object({
  candidateId: z.string().uuid(),
  candidateName: z.string(),
  url: z.string(),
  jobId: z.string().uuid().nullable(),
  jobTitle: z.string().nullable(),
  sourceJobId: z.string(),
  sourceRecordId: z.string().nullable(),
  verdict: z.enum(SCREENING_VERDICTS),
  reason: z.string().nullable(),
  criteria: z.array(
    z.object({ label: z.string(), result: z.string(), quote: z.string().optional() }),
  ),
  model: z.string().nullable(),
  screenedAt: z.string(),
});

export const putAiScreeningsContract = defineContract({
  method: "PUT",
  path: "/api/v1/integrations/ai-screenings",
  operationId: "putAiScreenings",
  summary: "Write first-pass AI resume screens",
  description:
    "Insert or replace first-pass AI screens, one per candidate and job. Send `candidateId`, or `sourceRecordId` of a BOSS import to resolve the candidate. A screen older than the stored one for the same candidate and job is skipped, so replays are safe. Items that cannot be resolved are reported under `unresolved` and the rest are still written. A screen is a suggestion for reviewers; it never changes a stage or status. Each request is recorded in the audit log with counts only.",
  tags: ["Candidates"],
  auth: { scopes: ["candidates:write"], keyTypes: ["secret"] },
  requestBody: aiScreeningsRequestSchema,
  responses: {
    200: successEnvelopeSchema(
      z.object({
        written: z.number().int(),
        skippedOlder: z.number().int(),
        unresolved: z.array(
          z.object({
            index: z.number().int(),
            reason: z.enum(["candidate_not_found", "source_record_unknown"]),
          }),
        ),
      }),
    ),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    422: errorEnvelopeSchema,
  },
});

export const listAiScreeningsQuery = z.object({
  candidateId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  sourceJobId: z.string().max(64).optional(),
  verdict: z.enum(SCREENING_VERDICTS).optional(),
  since: z.string().max(40).optional().describe("Screened on or after this YYYY-MM-DD date or ISO time."),
  until: z.string().max(40).optional().describe("Screened before this date or time."),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listAiScreeningsContract = defineContract({
  method: "GET",
  path: "/api/v1/ai-screenings",
  operationId: "listAiScreenings",
  summary: "List first-pass AI resume screens",
  description:
    "Screens newest first, with the exact total and the count per verdict (strong, maybe, no) for the same filter. Each row carries the candidate link, the verdict, the one-line reason, the model and the time it was screened.",
  tags: ["Candidates"],
  auth: { scopes: ["candidates:read"] },
  parameters: { query: listAiScreeningsQuery },
  responses: {
    200: successEnvelopeSchema(
      z.object({
        total: z.number().int(),
        byVerdict: z.object({ strong: z.number().int(), maybe: z.number().int(), no: z.number().int() }),
        limit: z.number().int(),
        offset: z.number().int(),
        nextOffset: z.number().int().nullable(),
        screenings: z.array(screeningSchema),
      }),
    ),
    400: errorEnvelopeSchema,
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
  },
});

export const aiScreeningsContracts = [putAiScreeningsContract, listAiScreeningsContract];
