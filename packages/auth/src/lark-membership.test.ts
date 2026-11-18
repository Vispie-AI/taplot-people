import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock("@harly/db", () => {
  const table = {
    id: "id",
    userId: "user",
    organizationId: "org",
    providerId: "provider",
    accountId: "subject",
    email: "email",
    status: "status",
    expiresAt: "expiry",
  };
  const query = () =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "then"
            ? (resolve: (rows: unknown[]) => void) =>
                resolve(state.queue.shift() ?? [])
            : () => query(),
      },
    );
  return {
    db: { select: query },
    account: table,
    invitation: table,
    member: table,
    organization: table,
    user: table,
  };
});
vi.mock("drizzle-orm", () => ({
  and: (...items: unknown[]) => items,
  eq: (...items: unknown[]) => items,
  gt: (...items: unknown[]) => items,
  sql: (...items: unknown[]) => items,
}));
import { authorizeLarkMember } from "./lark-membership";
const identity = {
  subject: "cli_test:tenant_test:ou_employee",
  openId: "ou_employee",
  email: "owner@example.test",
  name: "Test Owner",
};
beforeEach(() => {
  state.queue = [];
});
const org = [{ id: "org" }];
describe("Harly Lark membership gate", () => {
  it("keeps a bound identity tied to its own active membership despite a changed mailbox", async () => {
    state.queue = [org, [{ userId: "existing-owner" }], [{ status: "active" }]];
    expect(await authorizeLarkMember(identity)).toBe(true);
    expect(state.queue).toEqual([]);
  });
  it("migrates a unique active legacy member without changing its role or ID", async () => {
    state.queue = [
      org,
      [],
      [{ id: "existing-owner" }],
      [],
      [{ status: "active" }],
    ];
    expect(await authorizeLarkMember(identity)).toBe(true);
    expect(state.queue).toEqual([]);
  });
  it.each(["inactive", "suspended"])(
    "rejects %s members even when an invite might exist",
    async (status) => {
      state.queue = [
        org,
        [{ userId: "member" }],
        [{ status }],
        [{ id: "invite" }],
      ];
      expect(await authorizeLarkMember(identity)).toBe(false);
      expect(state.queue).toHaveLength(1);
    },
  );
  it("does not rebind an account with another Lark identity to a recycled email", async () => {
    state.queue = [
      org,
      [],
      [{ id: "old-employee" }],
      [{ id: "other-binding" }],
    ];
    expect(await authorizeLarkMember(identity)).toBe(false);
  });
  it("allows an email-invited colleague to complete the normal invitation flow", async () => {
    state.queue = [org, [], [], [{ id: "pending-invite" }]];
    expect(await authorizeLarkMember(identity)).toBe(true);
  });
  it("denies a tenant employee with no Harly membership or valid invite", async () => {
    state.queue = [org, [], [], []];
    expect(await authorizeLarkMember(identity)).toBe(false);
  });
  it("denies ambiguous deployments and duplicate identities", async () => {
    state.queue = [[{ id: "one" }, { id: "two" }]];
    expect(await authorizeLarkMember(identity)).toBe(false);
    state.queue = [org, [{ userId: "one" }, { userId: "two" }]];
    expect(await authorizeLarkMember(identity)).toBe(false);
  });
});
