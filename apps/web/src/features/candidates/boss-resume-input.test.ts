import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maxResumeFileSize } from "@/lib/storage-validation";
import { parseBossResumeRequest } from "./boss-resume-input";

const bytes = Buffer.from("%PDF-1.7\nsynthetic resume\n%%EOF");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function request(
  options: { hash?: string; size?: number; metadata?: string } = {},
) {
  const form = new FormData();
  form.set(
    "metadata",
    options.metadata ??
      JSON.stringify({
        sourceRecordId: "rec-synthetic",
        sha256: options.hash ?? sha256,
        candidate: { name: "Synthetic Candidate" },
      }),
  );
  form.set(
    "file",
    new File(
      [options.size ? Buffer.alloc(options.size) : bytes],
      "resume.pdf",
      { type: "application/pdf" },
    ),
  );
  return new Request("https://example.test/api/v1/integrations/boss/resumes", {
    method: "POST",
    body: form,
  });
}

describe("BOSS original request validation", () => {
  it("accepts the full checksum and preserves the original bytes", async () => {
    const input = await parseBossResumeRequest(
      request({ hash: sha256.toUpperCase() }),
    );
    expect(input.sha256).toBe(sha256);
    expect(input.bytes).toEqual(bytes);
  });

  it("rejects a different document checksum", async () => {
    await expect(
      parseBossResumeRequest(request({ hash: "0".repeat(64) })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects invalid metadata before importing anything", async () => {
    await expect(
      parseBossResumeRequest(request({ metadata: "{}" })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("bounds a body without Content-Length", async () => {
    const input = request({ size: maxResumeFileSize + 70 * 1024 });
    expect(input.headers.has("content-length")).toBe(false);
    await expect(parseBossResumeRequest(input)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects duplicate multipart fields", async () => {
    const input = request();
    const form = await input.formData();
    form.append(
      "file",
      new File([bytes], "second.pdf", { type: "application/pdf" }),
    );
    await expect(
      parseBossResumeRequest(
        new Request(input.url, { method: "POST", body: form }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
