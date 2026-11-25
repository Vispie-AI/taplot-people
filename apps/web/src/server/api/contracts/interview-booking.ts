import { z } from "zod";
import { defineContract } from "./core";
import { errorEnvelopeSchema, successEnvelopeSchema } from "./types";

export const syncInterviewBookingResumeContract = defineContract({
  method: "POST",
  path: "/api/v1/integrations/interview-booking/resume",
  operationId: "syncInterviewBookingResume",
  summary: "Resolve candidate or upload resume from interview booking page",
  description:
    "Send multipart/form-data with metadata (JSON containing candidate name, email, and optional position/jobId/sha256) and an optional file (PDF, DOC, or DOCX; at most 10 MiB), or send application/json for lookup-only mode. When a file is provided, matches or creates the candidate, stores and attaches the verified resume, and links an application to the matching job. When no file is provided, looks up an existing candidate by email or unique display name so returning candidates still get their Taplot People link on subsequent interview invites.",
  tags: ["Candidates"],
  auth: { scopes: ["candidates:write"], keyTypes: ["secret"] },
  multipartBody: z.object({
    metadata: z
      .string()
      .describe(
        "JSON string containing name, email, and optional position, jobId, sha256",
      ),
    file: z.string().meta({ format: "binary" }).optional(),
  }),
  responses: {
    200: successEnvelopeSchema(
      z.object({
        found: z.boolean(),
        candidateId: z.string().uuid().nullable(),
        candidatePath: z.string().nullable(),
        fileId: z.string().uuid().nullable(),
        applicationId: z.string().uuid().nullable(),
        hasResume: z.boolean(),
        createdCandidate: z.boolean(),
        deduplicated: z.boolean(),
      }),
    ),
    400: errorEnvelopeSchema,
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
    409: errorEnvelopeSchema,
    422: errorEnvelopeSchema,
  },
});
