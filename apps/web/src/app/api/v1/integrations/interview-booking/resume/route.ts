import { parseInterviewBookingResumeRequest } from "@/features/candidates/interview-booking-input";
import { syncInterviewBookingResume } from "@/features/candidates/interview-booking-service";
import { buildRouteHandler } from "@/server/api/contracts";
import { syncInterviewBookingResumeContract } from "@/server/api/contracts/interview-booking";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const POST = withApi(
  buildRouteHandler(
    syncInterviewBookingResumeContract,
    async ({ request, auth }) => {
      const input = await parseInterviewBookingResumeRequest(request);
      return apiOk(await syncInterviewBookingResume(auth.workspaceId, input));
    },
  ),
);
