import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@harly/api";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), sync: vi.fn() }));
vi.mock("@/server/api/auth", () => ({
  authenticateApiKey: mocks.authenticate,
  getRequestRateLimit: () => null,
}));
vi.mock("@/features/candidates/interview-booking-service", () => ({
  syncInterviewBookingResume: mocks.sync,
}));

import { POST } from "./route";

function multipartRequest({
  withFile = true,
  fileName = "resume.pdf",
  fileType = "application/pdf",
  overrideSha,
}: {
  withFile?: boolean;
  fileName?: string;
  fileType?: string;
  overrideSha?: string;
} = {}) {
  const bytes = Buffer.from("%PDF-1.7\nSynthetic resume\n%%EOF");
  const sha256 = overrideSha ?? createHash("sha256").update(bytes).digest("hex");
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      name: "Jim Cao",
      email: "jim@example.com",
      position: "Founding Game Agent Engineer",
      ...(withFile ? { sha256 } : {}),
    }),
  );
  if (withFile) {
    form.set("file", new File([bytes], fileName, { type: fileType }));
  }
  return new Request(
    "https://example.test/api/v1/integrations/interview-booking/resume",
    { method: "POST", body: form },
  );
}

describe("Interview booking resume sync endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      workspaceId: "workspace-from-key",
      type: "secret",
    });
    mocks.sync.mockResolvedValue({
      found: true,
      candidateId: "11111111-1111-4111-8111-111111111111",
      candidatePath: "/dashboard/candidates/11111111-1111-4111-8111-111111111111",
      fileId: "22222222-2222-4222-8222-222222222222",
      applicationId: "33333333-3333-4333-8333-333333333333",
      hasResume: true,
      createdCandidate: true,
      deduplicated: false,
    });
  });

  it("uploads a multipart resume with secret key and candidates:write scope", async () => {
    const response = await POST(multipartRequest());
    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.any(Request),
      "candidates:write",
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      "workspace-from-key",
      expect.objectContaining({
        name: "Jim Cao",
        email: "jim@example.com",
        file: expect.objectContaining({
          fileName: "resume.pdf",
          contentType: "application/pdf",
        }),
      }),
    );
  });

  it("infers PDF MIME type from file extension when browser sends application/octet-stream", async () => {
    const response = await POST(
      multipartRequest({ fileName: "Jim_Cao_CV.PDF", fileType: "application/octet-stream" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(
      "workspace-from-key",
      expect.objectContaining({
        file: expect.objectContaining({
          contentType: "application/pdf",
        }),
      }),
    );
  });

  it("supports lookup-only JSON requests without a resume file", async () => {
    const req = new Request(
      "https://example.test/api/v1/integrations/interview-booking/resume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Jim Cao",
          email: "jim@example.com",
          position: "Founding Game Agent Engineer",
        }),
      },
    );
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(
      "workspace-from-key",
      expect.objectContaining({
        name: "Jim Cao",
        email: "jim@example.com",
        file: null,
      }),
    );
  });

  it("rejects mismatched sha256 before syncing", async () => {
    const response = await POST(
      multipartRequest({ overrideSha: "0".repeat(64) }),
    );
    expect(response.status).toBe(422);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects unsupported file extensions and MIME types", async () => {
    const response = await POST(
      multipartRequest({ fileName: "script.exe", fileType: "application/octet-stream" }),
    );
    expect(response.status).toBe(422);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and publishable keys", async () => {
    mocks.authenticate.mockRejectedValueOnce(ApiError.unauthorized());
    expect((await POST(multipartRequest())).status).toBe(401);

    mocks.authenticate.mockResolvedValueOnce({
      workspaceId: "workspace-from-key",
      type: "publishable",
    });
    expect((await POST(multipartRequest())).status).toBe(403);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
