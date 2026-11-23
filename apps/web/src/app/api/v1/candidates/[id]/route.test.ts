import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@harly/api";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), update: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/api/auth", () => ({
  authenticateApiKey: mocks.authenticate,
  getRequestRateLimit: () => null,
}));
vi.mock("@/server/api/idempotency", () => ({
  reserveIdempotencyKey: vi.fn(async () => ({ kind: "not_requested" })),
  releaseIdempotencyReservation: vi.fn(),
}));
vi.mock("@/server/observability/metrics", () => ({
  recordHttpError: vi.fn(),
  recordHttpRequest: vi.fn(),
}));
vi.mock("@/features/candidates/service", () => ({
  deleteCandidateForApi: vi.fn(),
  getCandidateForApi: vi.fn(),
  serializeCandidate: (candidate: unknown) => candidate,
  updateCandidateForApi: mocks.update,
}));

import { PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
function patch(body: unknown, headers: Record<string, string> = {}) {
  return PATCH(
    new Request(`https://example.test/api/v1/candidates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH /api/v1/candidates/{id}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      workspaceId: "workspace-from-key",
      keyId: "key-1",
      type: "secret",
      scopes: ["candidates:write"],
    });
    mocks.update.mockResolvedValue({ id });
  });

  it("requires the candidates:write scope and does not write without it", async () => {
    mocks.authenticate.mockRejectedValue(ApiError.forbidden());
    const response = await patch({ email: "new@example.test" });
    expect(response.status).toBe(403);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.any(Request),
      "candidates:write",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("passes email, expectedEmail and the key id to the service", async () => {
    const response = await patch({
      email: " New@Example.test ",
      expectedEmail: "Old@Example.test",
    });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      workspaceId: "workspace-from-key",
      candidateId: id,
      values: { email: "new@example.test", expectedEmail: "old@example.test" },
      actorKeyId: "key-1",
    });
  });

  it("accepts If-Match as the precondition", async () => {
    await patch({ email: "new@example.test" }, { "if-match": '"Old@Example.test"' });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { email: "new@example.test", expectedEmail: "old@example.test" },
      }),
    );
  });

  it("rejects a disagreeing If-Match and expectedEmail", async () => {
    const response = await patch(
      { email: "new@example.test", expectedEmail: "a@example.test" },
      { "if-match": "b@example.test" },
    );
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects fields the API would not store instead of dropping them", async () => {
    const response = await patch({ email: "new@example.test", avatarUrl: "https://example.test/a.png" });
    expect(response.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("renders the duplicate-email conflict as 409 candidate_email_exists", async () => {
    mocks.update.mockRejectedValue(
      ApiError.conflictWithReason("candidate_email_exists", "Another candidate already uses this email.", {
        candidateId: "other",
      }),
    );
    const response = await patch({ email: "taken@example.test" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "candidate_email_exists", details: { candidateId: "other" } },
    });
  });
});
