import { createHash } from "node:crypto";
import { ApiError } from "@harly/api";
import { z } from "zod";

import {
  allowedResumeContentTypes,
  maxResumeFileSize,
} from "@/lib/storage-validation";

export const interviewBookingMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(320),
    position: z.string().trim().max(500).optional(),
    jobId: z.uuid().optional(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((s) => s.toLowerCase())
      .optional(),
  })
  .strict();

export type InterviewBookingMetadata = z.infer<
  typeof interviewBookingMetadataSchema
>;

export type InterviewBookingFile = {
  bytes: Buffer;
  sha256: string;
  fileName: string;
  contentType: (typeof allowedResumeContentTypes)[number];
};

export type InterviewBookingResumeInput = InterviewBookingMetadata & {
  file: InterviewBookingFile | null;
};

const EXT_TO_MIME: Record<string, (typeof allowedResumeContentTypes)[number]> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function resolveResumeContentType(
  fileName: string,
  declaredType: string,
): (typeof allowedResumeContentTypes)[number] | null {
  if (
    allowedResumeContentTypes.includes(
      declaredType as (typeof allowedResumeContentTypes)[number],
    )
  ) {
    return declaredType as (typeof allowedResumeContentTypes)[number];
  }
  const lower = fileName.trim().toLowerCase();
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

async function readBoundedBody(request: Request, limit: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > limit || !request.body) {
    throw ApiError.badRequest(
      "Resume request exceeds the upload limit or has no body.",
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw ApiError.badRequest("Resume request exceeds the upload limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Bound the streamed body too: Content-Length is optional and untrusted. */
export async function parseInterviewBookingResumeRequest(
  request: Request,
): Promise<InterviewBookingResumeInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("application/json")) {
    const raw = await readBoundedBody(request, 64 * 1024);
    let parsed: InterviewBookingMetadata;
    try {
      parsed = interviewBookingMetadataSchema.parse(
        JSON.parse(raw.toString("utf8")),
      );
    } catch {
      throw ApiError.unprocessable("Invalid interview booking metadata.");
    }
    if (parsed.sha256) {
      throw ApiError.unprocessable("sha256 requires a multipart file part.");
    }
    return { ...parsed, file: null };
  }

  if (!contentType.startsWith("multipart/form-data;")) {
    throw ApiError.badRequest(
      "Expected multipart/form-data or application/json.",
    );
  }

  const raw = await readBoundedBody(request, maxResumeFileSize + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw ApiError.badRequest("Invalid multipart body.");
  }

  const metadata = form.get("metadata");
  const files = form.getAll("file");
  if (
    typeof metadata !== "string" ||
    form.getAll("metadata").length !== 1 ||
    files.length > 1
  ) {
    throw ApiError.badRequest(
      "Provide exactly one metadata JSON part and at most one file part.",
    );
  }

  let input: InterviewBookingMetadata;
  try {
    input = interviewBookingMetadataSchema.parse(JSON.parse(metadata));
  } catch {
    throw ApiError.unprocessable("Invalid interview booking metadata.");
  }

  const file = files[0];
  if (file === undefined) {
    if (input.sha256) {
      throw ApiError.unprocessable("sha256 requires a file part.");
    }
    return { ...input, file: null };
  }
  if (!(file instanceof File)) {
    throw ApiError.badRequest("The file part must be a binary file.");
  }

  const resolvedType = resolveResumeContentType(file.name, file.type);
  if (
    !file.name ||
    file.name.length > 255 ||
    file.size === 0 ||
    file.size > maxResumeFileSize ||
    !resolvedType
  ) {
    throw ApiError.unprocessable(
      "Expected a nonempty PDF, DOC, or DOCX of at most 10 MiB.",
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const computedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.sha256 && computedSha256 !== input.sha256) {
    throw ApiError.unprocessable(
      "Document SHA256 does not match the original.",
    );
  }

  return {
    ...input,
    file: {
      bytes,
      sha256: computedSha256,
      fileName: file.name,
      contentType: resolvedType,
    },
  };
}
