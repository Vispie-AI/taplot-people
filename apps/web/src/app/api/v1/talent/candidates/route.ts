import { listTaggingCandidates } from "@/features/talent/tagging-input";
import { buildRouteHandler } from "@/server/api/contracts";
import { listTaggingCandidatesContract } from "@/server/api/contracts/talent";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(listTaggingCandidatesContract, async ({ query, auth }) => {
    const q = query as { after?: string; limit?: number; untagged?: string };
    return apiOk(
      await listTaggingCandidates({
        workspaceId: auth.workspaceId,
        after: q.after,
        limit: q.limit ?? 200,
        untaggedOnly: q.untagged === "true",
      }),
    );
  }),
);
