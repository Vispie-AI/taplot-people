import { z } from "zod";
import { defineContract } from "./core";
import { errorEnvelopeSchema, successEnvelopeSchema } from "./types";

export const importBossResumeContract = defineContract({
  method: "POST",
  path: "/api/v1/integrations/boss/resumes",
  operationId: "importBossResume",
  summary: "Import a verified BOSS resume original",
  description:
    "Send multipart/form-data with metadata (JSON containing sourceRecordId, sha256, and candidate) and file (PDF, DOC, or DOCX; at most 10 MiB). Source-record progress is committed only after checksum verification and attachment association. Repeated content reuses an existing attachment in this workspace.",
  tags: ["Candidates"],
  auth: { scopes: ["candidates:write"], keyTypes: ["secret"] },
  // Multipart is parsed with a bounded stream in the handler, not the JSON parser.
  multipartBody: z.object({
    metadata: z
      .string()
      .describe(
        "JSON string containing sourceRecordId, sha256, and candidate (name, optional email, phone, position)",
      ),
    file: z.string().meta({ format: "binary" }),
  }),
  responses: {
    200: successEnvelopeSchema(
      z.object({
        sourceRecordId: z.string(),
        sha256: z.string(),
        candidateId: z.string().uuid(),
        fileId: z.string().uuid(),
        deduplicated: z.boolean(),
      }),
    ),
    400: errorEnvelopeSchema,
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    409: errorEnvelopeSchema,
    422: errorEnvelopeSchema,
  },
});
