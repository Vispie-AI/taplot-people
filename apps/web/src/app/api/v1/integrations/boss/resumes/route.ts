import { parseBossResumeRequest } from "@/features/candidates/boss-resume-input";
import { importBossResume } from "@/features/candidates/boss-resume-service";
import { buildRouteHandler } from "@/server/api/contracts";
import { importBossResumeContract } from "@/server/api/contracts/boss-resumes";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const POST = withApi(
  buildRouteHandler(importBossResumeContract, async ({ request, auth }) => {
    const input = await parseBossResumeRequest(request);
    return apiOk(await importBossResume(auth.workspaceId, input));
  }),
);
