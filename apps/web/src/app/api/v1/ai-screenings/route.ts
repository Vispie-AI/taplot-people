import { parseScreeningTime } from "@/features/ai-screenings/input";
import { listAiScreenings } from "@/features/ai-screenings/service";
import { getHarlyPublicOrigin } from "@/lib/public-origin";
import { buildRouteHandler } from "@/server/api/contracts";
import { listAiScreeningsContract, listAiScreeningsQuery } from "@/server/api/contracts/ai-screenings";
import { apiOk, withApi } from "@/server/api/respond";
import type { z } from "zod";
import { ApiError } from "@harly/api";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(listAiScreeningsContract, async ({ query: rawQuery, auth }) => {
    const query = rawQuery as z.infer<typeof listAiScreeningsQuery>;
    const since = parseScreeningTime(query.since);
    const until = parseScreeningTime(query.until);
    if ((query.since && !since) || (query.until && !until)) {
      throw ApiError.badRequest("since and until must be a YYYY-MM-DD date or an ISO time.");
    }
    const result = await listAiScreenings(
      { workspaceId: auth.workspaceId, appOrigin: getHarlyPublicOrigin() },
      { ...query, since, until },
    );
    return apiOk(result);
  }),
);
