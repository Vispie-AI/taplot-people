import { randomUUID } from "node:crypto";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, db, member, organization, schema, user } from "@harly/db";
import { createLarkProvider } from "./lark";
import { authorizeLarkMember, isLarkBoundStaffUser } from "./lark-membership";
import { allowsLarkSessionCreation } from "./staff-policy";

const integration =
  process.env.RUN_LARK_PROVISION_INTEGRATION === "1" ? describe : describe.skip;

integration("Lark employee Administrator enrollment", () => {
  const orgId = randomUUID();
  const employee = {
    subject: "cli_test:tenant_test:ou_employee",
    openId: "ou_employee",
    email: "employee@example.test",
    name: "Test Employee",
  };
  const owner = {
    subject: "cli_test:tenant_test:ou_owner",
    openId: "ou_owner",
    email: "owner@example.test",
    name: "Test Owner",
  };
  const ownerId = randomUUID();
  const newLoginEmail = "first-signin@example.test";

  beforeAll(async () => {
    await db.insert(organization).values({
      id: orgId,
      name: "Synthetic Lark Workspace",
      slug: `lark-${orgId}`,
      createdAt: new Date(),
    });
    await db.insert(user).values({ id: ownerId, email: owner.email, name: owner.name });
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(account).values({
      id: randomUUID(),
      accountId: ownerId,
      providerId: "credential",
      userId: ownerId,
      password: "fixture-password-hash",
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(inArray(user.email, [employee.email, owner.email, newLoginEmail]));
  });

  it("creates one Admin and one binding under parallel first sign-ins, without changing the existing Owner", async () => {
    await expect(authorizeLarkMember(employee)).resolves.toBe(false);
    expect(await Promise.all([
      authorizeLarkMember(employee, true),
      authorizeLarkMember(employee, true),
    ])).toEqual([true, true]);

    const users = await db.select().from(user).where(eq(user.email, employee.email));
    expect(users).toHaveLength(1);
    const enrolled = users[0]!;
    expect(enrolled.emailVerified).toBe(true);
    const credentials = await db.select().from(account).where(eq(account.userId, enrolled.id));
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ providerId: "lark", accountId: employee.subject, password: null });
    const memberships = await db.select().from(member).where(eq(member.userId, enrolled.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organizationId: orgId, role: "admin", status: "active" });

    await expect(authorizeLarkMember(owner, true)).resolves.toBe(true);
    expect(await db.select({ role: member.role }).from(member).where(eq(member.userId, ownerId)))
      .toEqual([{ role: "owner" }]);
    expect(await db.select({ provider: account.providerId, password: account.password })
      .from(account).where(eq(account.userId, ownerId)))
      .toEqual([{ provider: "credential", password: "fixture-password-hash" }]);

    await expect(authorizeLarkMember({
      ...employee,
      subject: "cli_test:tenant_test:ou_other",
      openId: "ou_other",
    }, true)).resolves.toBe(false);
    await db.update(member).set({ status: "suspended" }).where(eq(member.userId, enrolled.id));
    await expect(authorizeLarkMember(employee, true)).resolves.toBe(false);
    await db.delete(member).where(eq(member.userId, enrolled.id));
    await expect(authorizeLarkMember(employee, true)).resolves.toBe(false);
    expect(await db.select().from(member).where(eq(member.userId, enrolled.id))).toHaveLength(0);
  });

  it("gives a first-time employee a native OAuth session while an existing Owner can still use their password", async () => {
    const origin = "https://harly.example.test";
    const profile = {
      open_id: "ou_first",
      tenant_key: "tenant_test",
      enterprise_email: newLoginEmail,
      name: "First Employee",
    };
    const provider = createLarkProvider(
      { origin, appId: "cli_test", secret: "fixture-secret", tenant: profile.tenant_key },
      (identity) => authorizeLarkMember(identity, true),
      async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/oauth/token")) return Response.json({ access_token: "fixture-user-token" });
        if (path.endsWith("/user_info")) return Response.json({ code: 0, data: profile });
        if (path.endsWith("/tenant_access_token/internal")) {
          return Response.json({ code: 0, tenant_access_token: "fixture-tenant-token" });
        }
        if (path.endsWith("/users/ou_first")) {
          return Response.json({ code: 0, data: { user: { ...profile, status: { is_activated: true } } } });
        }
        if (path.endsWith("/check_white_black_list")) {
          return Response.json({
            code: 0, data: { user_visibility_list: [{
              user_id: profile.open_id, in_white_list: true, in_black_list: false,
            }] },
          });
        }
        throw new Error("Unexpected fixture endpoint");
      },
    );
    const auth = betterAuth({
      baseURL: origin,
      secret: "fixture-better-auth-secret-long-enough",
      database: drizzleAdapter(db, { provider: "pg", schema }),
      emailAndPassword: { enabled: true },
      plugins: [genericOAuth({ config: [provider] })],
      // The callback must find the enrolled account rather than fall through
      // to the native user creation path, where staff signup is invite only.
      databaseHooks: {
        user: { create: { before: async () => { throw new Error("Invite required"); } } },
        session: {
          create: {
            before: async (session, context) => {
              if (
                !allowsLarkSessionCreation(
                  context?.path,
                  context?.params,
                  session.userId,
                  context?.context.session?.session.userId,
                ) &&
                await isLarkBoundStaffUser(session.userId)
              ) {
                throw new APIError("FORBIDDEN");
              }
              return { data: session };
            },
          },
        },
      },
    });
    const post = (path: string, body: object) => auth.handler(new Request(origin + path, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }));
    const cookies = (response: Response) =>
      response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const start = await post("/api/auth/sign-in/social", {
      provider: "lark",
      callbackURL: "/dashboard",
    });
    expect(start.status).toBe(200);
    const redirect = new URL((await start.json()).url);
    const query = new URLSearchParams({ code: "fixture-code", state: redirect.searchParams.get("state")! });
    const callback = await auth.handler(new Request(origin + "/api/auth/callback/lark?" + query, {
      headers: { cookie: cookies(start) },
    }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies(callback) }) });
    expect(session?.user.email).toBe(newLoginEmail);
    expect(await db.select({ role: member.role }).from(member)
      .where(eq(member.userId, session!.user.id))).toEqual([{ role: "admin" }]);

    const password = "fixture-owner-password";
    const hash = await (await auth.$context).password.hash(password);
    await db.update(account).set({ password: hash }).where(eq(account.userId, ownerId));
    const passwordLogin = await post("/api/auth/sign-in/email", { email: owner.email, password });
    expect(passwordLogin.status).toBe(200);
    expect((await passwordLogin.json()).user.id).toBe(ownerId);

    const enrolledId = session!.user.id;
    await db.insert(account).values({
      id: randomUUID(),
      accountId: enrolledId,
      providerId: "credential",
      userId: enrolledId,
      password: hash,
      updatedAt: new Date(),
    });
    const alternateLogin = await post("/api/auth/sign-in/email", {
      email: newLoginEmail,
      password,
    });
    expect(alternateLogin.status).toBe(403);
    expect(cookies(alternateLogin)).toBe("");
  });
});
