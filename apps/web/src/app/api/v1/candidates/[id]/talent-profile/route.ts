import { ApiError } from "@harly/api";
import { ZodError } from "zod";

import {
  normalizeTalentProfile,
  TalentProfileValidationError,
} from "@/features/talent/profile-input";
import {
  deleteTalentProfile,
  getTalentProfile,
  upsertTalentProfile,
} from "@/features/talent/service";
import { extractRequestMeta } from "@/lib/audit-log";
import { getHarlyPublicOrigin } from "@/lib/public-origin";
import { buildRouteHandler } from "@/server/api/contracts";
import {
  deleteTalentProfileContract,
  getTalentProfileContract,
  putTalentProfileContract,
} from "@/server/api/contracts/talent";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const GET = withApi(
  buildRouteHandler(getTalentProfileContract, async ({ params, auth }) => {
    const profile = await getTalentProfile(
      { workspaceId: auth.workspaceId, appOrigin: getHarlyPublicOrigin() },
      params.id,
    );
    if (!profile) throw ApiError.notFound("This candidate has no talent profile.");
    return apiOk(profile);
  }),
);

export const PUT = withApi(
  buildRouteHandler(
    putTalentProfileContract,
    async ({ params, body, auth, request }) => {
      let profile;
      try {
        profile = normalizeTalentProfile(body);
      } catch (error) {
        if (error instanceof TalentProfileValidationError) {
          throw ApiError.unprocessable(error.message, { issues: error.issues });
        }
        if (error instanceof ZodError) {
          throw ApiError.unprocessable("Validation failed.", error.issues);
        }
        throw error;
      }
      const meta = extractRequestMeta(request);
      const { created } = await upsertTalentProfile({
        workspaceId: auth.workspaceId,
        candidateId: params.id,
        profile,
        audit: {
          keyId: auth.keyId,
          actorId: auth.createdById,
          ipAddress: meta.ipAddress ?? undefined,
          userAgent: meta.userAgent,
        },
      });
      const view = await getTalentProfile(
        { workspaceId: auth.workspaceId, appOrigin: getHarlyPublicOrigin() },
        params.id,
      );
      return apiOk(view, { status: created ? 201 : 200 });
    },
  ),
);

export const DELETE = withApi(
  buildRouteHandler(deleteTalentProfileContract, async ({ params, auth, request }) => {
    const meta = extractRequestMeta(request);
    const deleted = await deleteTalentProfile({
      workspaceId: auth.workspaceId,
      candidateId: params.id,
      audit: {
        keyId: auth.keyId,
        actorId: auth.createdById,
        ipAddress: meta.ipAddress ?? undefined,
        userAgent: meta.userAgent,
      },
    });
    return apiOk({ deleted });
  }),
);
