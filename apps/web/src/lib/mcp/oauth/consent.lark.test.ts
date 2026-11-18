import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ requires2fa: false, allow: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/features/workspaces/permissions-server", () => ({ hasActorPermission: async () => state.allow }));
vi.mock("../settings", () => ({ getWorkspaceMcpSettings: async () => ({ enabled: true, clientMode: "any", allowedScopes: ["candidates:read"] }) }));
vi.mock("@harly/db", () => {
  let reads = 0;
  const table = { id: "id", organizationId: "org", userId: "user", twoFactorEnabled: "factor", mustChangePassword: "change" };
  const query = (): object => new Proxy({}, { get: (_target, property) => property === "then" ? (resolve: (value: unknown) => void) => {
    const slot = reads++ % 3;
    resolve(slot === 0 ? [{ require2fa: state.requires2fa }] : slot === 1 ? [{ mustChangePassword: true, twoFactorEnabled: false }] : []);
  } : () => query() });
  return { db: { select: query }, workspaceSettings: table, user: table, passkeys: table };
});
import { evaluateConsentGate } from "./consent";
const context = { organization: { id: "org" }, user: { id: "user", email: "member@example.test" }, roleKey: "recruiter" };
const request = { scopes: ["candidates:read"], client: { known: true } };
const run = () => evaluateConsentGate(context as never, request as never, new Headers());
afterEach(() => { vi.unstubAllEnvs(); state.requires2fa = false; state.allow = true; });
it("retains the forced local credential gate in ordinary mode", async () => {
  vi.stubEnv("HARLY_STAFF_AUTH_MODE", "default");
  expect(await run()).toMatchObject({ ok: false, block: { reason: "must_change_password" } });
});
it("Lark-only mode still checks permissions and second-factor policy", async () => {
  vi.stubEnv("HARLY_STAFF_AUTH_MODE", "lark-only");
  expect(await run()).toMatchObject({ ok: true, grantedScopes: ["candidates:read"] });
  state.requires2fa = true;
  expect(await run()).toMatchObject({ ok: false, block: { reason: "needs_2fa" } });
  state.allow = false;
  expect(await run()).toMatchObject({ ok: false, block: { reason: "no_permission" } });
});
