import { ZodError } from "zod";
import { ApiError } from "@harly/api";

import { aiScreeningsRequestSchema } from "@/features/ai-screenings/input";
import { upsertAiScreenings } from "@/features/ai-screenings/service";
import { extractRequestMeta } from "@/lib/audit-log";
import { buildRouteHandler } from "@/server/api/contracts";
import { putAiScreeningsContract } from "@/server/api/contracts/ai-screenings";
import { apiOk, withApi } from "@/server/api/respond";

export const runtime = "nodejs";

export const PUT = withApi(
  buildRouteHandler(putAiScreeningsContract, async ({ body, auth, request }) => {
    let parsed;
    try {
      parsed = aiScreeningsRequestSchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw ApiError.unprocessable("Validation failed.", error.issues);
      }
      throw error;
    }
    const meta = extractRequestMeta(request);
    const result = await upsertAiScreenings({
      workspaceId: auth.workspaceId,
      items: parsed.items,
      audit: {
        keyId: auth.keyId,
        actorId: auth.createdById,
        ipAddress: meta.ipAddress ?? undefined,
        userAgent: meta.userAgent,
      },
    });
    return apiOk(result);
  }),
);
