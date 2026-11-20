import {
  deleteCandidateForApi,
  getCandidateForApi,
  serializeCandidate,
  updateCandidateForApi,
} from "@/features/candidates/service";
import { buildRouteHandler } from "@/server/api/contracts";
import {
  deleteCandidateContract,
  getCandidateContract,
  candidateUpdateRequestSchema,
  updateCandidateContract,
} from "@/server/api/contracts/candidates";
import { apiOk, withApi } from "@/server/api/respond";
import { ApiError } from "@harly/api";

export const runtime = "nodejs";

/** `If-Match: <email>` (optionally quoted); `*` means no precondition. */
function ifMatchEmail(request: Request): string | undefined {
  const raw = request.headers.get("if-match")?.trim();
  if (!raw || raw === "*") return undefined;
  const value = raw.replace(/^W\//, "").replace(/^"(.*)"$/, "$1").trim();
  return value ? value.toLowerCase() : undefined;
}

export const GET = withApi(
  buildRouteHandler(getCandidateContract, async ({ params, auth }) => {
    const candidate = await getCandidateForApi({
      workspaceId: auth.workspaceId,
      candidateId: params.id,
    });
    return apiOk(serializeCandidate(candidate));
  }),
);

export const PATCH = withApi(
  buildRouteHandler(
    updateCandidateContract,
    async ({ params, body, auth, request }) => {
    const values = candidateUpdateRequestSchema.parse(body);
    const ifMatch = ifMatchEmail(request);
    if (
      ifMatch !== undefined &&
      values.expectedEmail !== undefined &&
      ifMatch !== values.expectedEmail
    ) {
      throw ApiError.badRequest(
        "`If-Match` and `expectedEmail` disagree; send only one.",
      );
    }
    const candidate = await updateCandidateForApi({
      workspaceId: auth.workspaceId,
      candidateId: params.id,
      values: { ...values, expectedEmail: values.expectedEmail ?? ifMatch },
      actorKeyId: auth.keyId,
    });
    return apiOk(serializeCandidate(candidate));
    },
  ),
);

export const DELETE = withApi(
  buildRouteHandler(deleteCandidateContract, async ({ params, auth }) => {
    await deleteCandidateForApi({
      workspaceId: auth.workspaceId,
      candidateId: params.id,
    });
    return apiOk({ deleted: true });
  }),
);
