import { talentFiltersFromQuery, type TalentSearchQuery } from "@/features/talent/query-params";
import { searchTalent } from "@/features/talent/service";
import { getHarlyPublicOrigin } from "@/lib/public-origin";
import { buildRouteHandler } from "@/server/api/contracts";
import { searchTalentContract } from "@/server/api/contracts/talent";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(searchTalentContract, async ({ query, auth }) => {
    const result = await searchTalent(
      { workspaceId: auth.workspaceId, appOrigin: getHarlyPublicOrigin() },
      talentFiltersFromQuery(query as TalentSearchQuery),
    );
    return apiOk(result);
  }),
);
