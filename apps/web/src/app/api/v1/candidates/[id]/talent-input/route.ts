import { loadTaggingInput } from "@/features/talent/tagging-input";
import { buildRouteHandler } from "@/server/api/contracts";
import { getTaggingInputContract } from "@/server/api/contracts/talent";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(getTaggingInputContract, async ({ params, query, auth }) => {
    const q = query as { maxChars?: number };
    return apiOk(
      await loadTaggingInput({
        workspaceId: auth.workspaceId,
        candidateId: params.id,
        maxChars: q.maxChars ?? 20000,
      }),
    );
  }),
);
