import { createHash } from "node:crypto";
import { ApiError } from "@harly/api";
import { z } from "zod";

import {
  allowedResumeContentTypes,
  maxResumeFileSize,
} from "@/lib/storage-validation";

export const bossResumeMetadataSchema = z
  .object({
    sourceRecordId: z.string().trim().min(1).max(128),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((s) => s.toLowerCase()),
    candidate: z
      .object({
        name: z.string().trim().min(1).max(255),
        email: z.string().trim().email().max(320).optional(),
        phone: z.string().trim().min(1).max(64).optional(),
        position: z.string().trim().max(500).optional(),
      })
      .strict(),
  })
  .strict();

export type BossResumeMetadata = z.infer<typeof bossResumeMetadataSchema>;
export type BossResumeInput = BossResumeMetadata & {
  bytes: Buffer;
  fileName: string;
  contentType: (typeof allowedResumeContentTypes)[number];
};

/** Bound the streamed body too: Content-Length is optional and untrusted. */
export async function parseBossResumeRequest(
  request: Request,
): Promise<BossResumeInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw ApiError.badRequest(
      "Expected multipart/form-data with metadata and file parts.",
    );
  }
  const limit = maxResumeFileSize + 64 * 1024;
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
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw ApiError.badRequest("Invalid multipart body.");
  }
  const metadata = form.get("metadata");
  const file = form.get("file");
  if (
    typeof metadata !== "string" ||
    !(file instanceof File) ||
    form.getAll("metadata").length !== 1 ||
    form.getAll("file").length !== 1
  ) {
    throw ApiError.badRequest(
      "Provide exactly one metadata JSON part and one file part.",
    );
  }
  let input: BossResumeMetadata;
  try {
    input = bossResumeMetadataSchema.parse(JSON.parse(metadata));
  } catch {
    throw ApiError.unprocessable("Invalid resume metadata.");
  }
  if (
    !file.name ||
    file.name.length > 255 ||
    file.size === 0 ||
    file.size > maxResumeFileSize ||
    !allowedResumeContentTypes.includes(
      file.type as BossResumeInput["contentType"],
    )
  ) {
    throw ApiError.unprocessable(
      "Expected a nonempty PDF, DOC, or DOCX of at most 10 MiB.",
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
    throw ApiError.unprocessable(
      "Document SHA256 does not match the original.",
    );
  }
  return {
    ...input,
    bytes,
    fileName: file.name,
    contentType: file.type as BossResumeInput["contentType"],
  };
}
