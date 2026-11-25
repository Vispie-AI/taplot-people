import { talentStats } from "@/features/talent/service";
import { getHarlyPublicOrigin } from "@/lib/public-origin";
import { buildRouteHandler } from "@/server/api/contracts";
import { talentStatsContract } from "@/server/api/contracts/talent";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(talentStatsContract, async ({ query, auth }) => {
    const q = query as { weeks?: number; top?: number };
    return apiOk(
      await talentStats(
        { workspaceId: auth.workspaceId, appOrigin: getHarlyPublicOrigin() },
        { weeks: q.weeks, top: q.top },
      ),
    );
  }),
);
