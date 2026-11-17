import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@harly/api";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), import: vi.fn() }));
vi.mock("@/server/api/auth", () => ({
  authenticateApiKey: mocks.authenticate,
  getRequestRateLimit: () => null,
}));
vi.mock("@/features/candidates/boss-resume-service", () => ({
  importBossResume: mocks.import,
}));

import { POST } from "./route";

function request() {
  const bytes = Buffer.from("%PDF-1.7\nSynthetic resume\n%%EOF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      sourceRecordId: "rec-example",
      sha256,
      candidate: { name: "Synthetic Candidate" },
    }),
  );
  form.set(
    "file",
    new File([bytes], "resume.pdf", { type: "application/pdf" }),
  );
  return new Request("https://example.test/api/v1/integrations/boss/resumes", {
    method: "POST",
    body: form,
  });
}

describe("BOSS resume machine endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      workspaceId: "workspace-from-key",
      type: "secret",
    });
    mocks.import.mockResolvedValue({
      candidateId: "candidate-example",
      fileId: "file-example",
    });
  });

  it("uses the authenticated workspace and candidates:write scope", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.any(Request),
      "candidates:write",
    );
    expect(mocks.import).toHaveBeenCalledWith(
      "workspace-from-key",
      expect.objectContaining({ sourceRecordId: "rec-example" }),
    );
  });

  it("rejects an unauthenticated call before importing", async () => {
    mocks.authenticate.mockRejectedValue(ApiError.unauthorized());
    expect((await POST(request())).status).toBe(401);
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("rejects a publishable key before importing", async () => {
    mocks.authenticate.mockResolvedValue({
      workspaceId: "workspace-from-key",
      type: "publishable",
    });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.import).not.toHaveBeenCalled();
  });
});
