import { createHash } from "node:crypto";
import { betterAuth, APIError } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { createLarkProvider } from "./lark";
import {
  blocksStaffAuth,
  allowsLarkSessionCreation,
  isLarkConfigured,
  isLarkOnly,
} from "./staff-policy";

const config = {
  appId: "cli_test",
  secret: "test-only-client-secret",
  tenant: "tenant_test",
  origin: "https://harly.example.test",
};
const identity = {
  subject: "cli_test:tenant_test:ou_employee",
  openId: "ou_employee",
  email: "owner@example.test",
  name: "Test Owner",
};
function fixture() {
  const profile = {
    open_id: identity.openId,
    tenant_key: config.tenant,
    name: identity.name,
    enterprise_email: identity.email,
    email: "untrusted@example.test",
  };
  const directory = {
    ...profile,
    status: {
      is_activated: true,
      is_exited: false,
      is_frozen: false,
      is_resigned: false,
      is_unjoin: false,
    },
  };
  const visibility = {
    user_id: identity.openId,
    in_white_list: true,
    in_black_list: false,
  };
  const authorize = vi.fn(async () => true);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      let body: unknown;
      if (path.endsWith("/oauth/token"))
        body = { access_token: "test-only-user-token", expires_in: 7200 };
      else if (path.endsWith("/tenant_access_token/internal"))
        body = { code: 0, tenant_access_token: "test-only-tenant-token" };
      else if (path.endsWith("/user_info")) body = { code: 0, data: profile };
      else if (path.includes("/contact/v3/users/"))
        body = { code: 0, data: { user: directory } };
      else if (path.endsWith("/check_white_black_list"))
        body = { code: 0, data: { user_visibility_list: [visibility] } };
      else throw new Error("Unexpected endpoint");
      return Response.json(body);
    },
  );
  const provider = createLarkProvider(
    config,
    authorize,
    fetcher as typeof fetch,
  );
  return {
    profile,
    directory,
    visibility,
    authorize,
    calls,
    fetcher,
    provider,
  };
}

describe("Lark staff identity", () => {
  it("uses JSON token exchange with the native PKCE verifier and pinned redirect", async () => {
    const f = fixture();
    await f.provider.getToken!({
      code: "code",
      codeVerifier: "verifier",
      redirectURI: `${config.origin}/api/auth/callback/lark`,
    });
    expect(JSON.parse(f.calls[0]!.init!.body as string)).toMatchObject({
      code_verifier: "verifier",
      client_secret: config.secret,
      redirect_uri: `${config.origin}/api/auth/callback/lark`,
    });
    await expect(
      f.provider.getToken!({
        code: "code",
        redirectURI: "https://attacker.example.test",
      }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it("uses only enterprise email after active-directory, visibility and Harly checks", async () => {
    const f = fixture();
    expect(
      await f.provider.getUserInfo!({ accessToken: "test-only-user-token" }),
    ).toEqual({
      id: identity.subject,
      email: identity.email,
      emailVerified: true,
      name: identity.name,
    });
    expect(f.authorize).toHaveBeenCalledWith(identity);
    expect(f.calls).toHaveLength(4);
    for (const { init } of f.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
    }
  });
  it.each([
    "tenant",
    "inactive",
    "exited",
    "frozen",
    "personal-email",
    "conflict",
    "visibility",
    "membership",
  ])("rejects %s identities before linking", async (failure) => {
    const f = fixture();
    if (failure === "tenant") f.profile.tenant_key = "other";
    if (failure === "inactive") f.directory.status.is_activated = false;
    if (failure === "exited") f.directory.status.is_exited = true;
    if (failure === "frozen") f.directory.status.is_frozen = true;
    if (failure === "personal-email") f.directory.enterprise_email = "";
    if (failure === "conflict")
      f.profile.enterprise_email = "someone-else@example.test";
    if (failure === "visibility") f.visibility.in_black_list = true;
    if (failure === "membership") f.authorize.mockResolvedValue(false);
    expect(
      await f.provider.getUserInfo!({ accessToken: "test-only-user-token" }),
    ).toBeNull();
  });
  it("fails closed on a directory/provider outage", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      Response.json({ code: 999, msg: "unavailable" }),
    );
    await expect(
      f.provider.getUserInfo!({ accessToken: "test-only-user-token" }),
    ).rejects.toThrow("Lark authentication unavailable");
    expect(f.authorize).not.toHaveBeenCalled();
  });
});

describe("staff-only authentication policy", () => {
  it.each([
    "/sign-in/email",
    "/sign-in/magic-link",
    "/sign-in/sso",
    "/sso/callback/test",
    "/callback/google",
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/set-password",
    "/change-email",
    "/magic-link/verify",
    "/unlink-account",
    "/oauth2/sign-in",
  ])("blocks %s", (path) => {
    expect(blocksStaffAuth(path)).toBe(true);
  });
  it("permits only Lark social entry and keeps ordinary session/navigation endpoints", () => {
    expect(blocksStaffAuth("/sign-in/social", { provider: "lark" })).toBe(
      false,
    );
    expect(blocksStaffAuth("/sign-in/social", { provider: "google" })).toBe(
      true,
    );
    expect(
      blocksStaffAuth("/sign-in/social", {
        provider: "lark",
        idToken: { token: "invalid" },
      }),
    ).toBe(true);
    for (const path of [
      "/callback/lark",
      "/get-session",
      "/sign-out",
      "/organization/accept-invitation",
    ])
      expect(blocksStaffAuth(path)).toBe(false);
    expect(isLarkOnly({})).toBe(false);
    expect(
      isLarkConfigured({ LARK_CLIENT_ID: "id", LARK_CLIENT_SECRET: "secret" }),
    ).toBe(false);
  });
});

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

it("native OAuth state/PKCE callback preserves the existing account and cannot replay", async () => {
  const f = fixture();
  const now = new Date();
  const storage: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "existing-owner",
        name: identity.name,
        email: identity.email,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    account: [
      {
        id: "old-credential",
        userId: "existing-owner",
        providerId: "credential",
        accountId: "existing-owner",
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    verification: [],
    twoFactor: [],
  };
  const auth = betterAuth({
    baseURL: config.origin,
    secret: "test-only-native-auth-secret-long-enough",
    database: memoryAdapter(storage),
    session: {
      expiresIn: 8 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            if (
              !allowsLarkSessionCreation(
                context?.path,
                context?.params,
                session.userId,
                context?.context.session?.session.userId,
              )
            )
              throw new APIError("FORBIDDEN");
            return { data: session };
          },
        },
      },
    },
    account: { accountLinking: { requireLocalEmailVerified: false } },
    emailAndPassword: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (blocksStaffAuth(ctx.path, ctx.body, ctx.params))
          throw new APIError("FORBIDDEN");
      }),
    },
    plugins: [genericOAuth({ config: [f.provider] }), twoFactor()],
  });
  storage.account[0]!.password = await (
    await auth.$context
  ).password.hash("synthetic-known-password");
  const denied = await auth.handler(
    new Request(`${config.origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.origin },
      body: JSON.stringify({
        email: identity.email,
        password: "ignored-test-value",
      }),
    }),
  );
  expect(denied.status).toBe(403);
  const start = await auth.handler(
    new Request(`${config.origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.origin },
      body: JSON.stringify({ provider: "lark", callbackURL: "/dashboard" }),
    }),
  );
  expect(start.status).toBe(200);
  const url = new URL((await start.json()).url);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const callback = `${config.origin}/api/auth/callback/lark?code=test-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`;
  const finish = await auth.handler(
    new Request(callback, { headers: { cookie: cookieHeader(start) } }),
  );
  expect(finish.status).toBe(302);
  expect(finish.headers.get("location")).toBe("/dashboard");
  expect(storage.user).toHaveLength(1);
  expect(
    storage.account.find((row) => row.providerId === "lark"),
  ).toMatchObject({ userId: "existing-owner", accountId: identity.subject });
  expect(storage.session).toHaveLength(1);
  const tokenBody = JSON.parse(
    f.calls.find((call) => call.url.endsWith("/oauth/token"))!.init!
      .body as string,
  );
  expect(
    createHash("sha256").update(tokenBody.code_verifier).digest("base64url"),
  ).toBe(url.searchParams.get("code_challenge"));
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader(finish) }),
  });
  expect(session?.user.id).toBe("existing-owner");
  expect(
    (storage.session[0]!.expiresAt as Date).getTime() -
      (storage.session[0]!.createdAt as Date).getTime(),
  ).toBe(8 * 3600 * 1000);
  const originalId = storage.session[0]!.id;
  const rotation = await auth.handler(
    new Request(`${config.origin}/api/auth/two-factor/disable`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: config.origin,
        cookie: cookieHeader(finish),
      },
      body: JSON.stringify({ password: "synthetic-known-password" }),
    }),
  );
  expect(rotation.status).toBe(200);
  expect(storage.session).toHaveLength(1);
  expect(storage.session[0]!.id).not.toBe(originalId);

  await auth.handler(
    new Request(callback, { headers: { cookie: cookieHeader(start) } }),
  );
  expect(storage.session).toHaveLength(1);
  const context = await auth.$context;
  await expect(
    context.internalAdapter.createSession("existing-owner"),
  ).rejects.toThrow();
  expect(storage.session).toHaveLength(1);
});

it("distinguishes authenticated factor rotation from an unfinished recovery login", () => {
  expect(
    allowsLarkSessionCreation(
      "/two-factor/verify-totp",
      undefined,
      "owner",
      "owner",
    ),
  ).toBe(true);
  expect(
    allowsLarkSessionCreation("/two-factor/verify-totp", undefined, "owner"),
  ).toBe(false);
  expect(
    allowsLarkSessionCreation(
      "/two-factor/disable",
      undefined,
      "owner",
      "someone-else",
    ),
  ).toBe(false);
  expect(
    allowsLarkSessionCreation("/sign-in/email", undefined, "owner", "owner"),
  ).toBe(false);
});
