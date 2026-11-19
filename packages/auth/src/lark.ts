import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

const API = "https://open.larksuite.com/open-apis";
const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export type LarkIdentity = {
  subject: string;
  openId: string;
  email: string;
  name: string;
};
export type LarkConfig = {
  appId: string;
  secret: string;
  tenant: string;
  origin: string;
};

/** Ported from the existing GTM Lark flow; Better Auth owns state, PKCE and sessions. */
export function createLarkProvider(
  config: LarkConfig,
  authorize: (identity: LarkIdentity) => Promise<boolean>,
  request: typeof fetch = fetch,
): GenericOAuthConfig<"lark"> {
  const redirectURI = `${config.origin}/api/auth/callback/lark`;
  async function json(path: string, init: RequestInit = {}) {
    try {
      const response = await request(`${API}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      if (
        response.ok &&
        body &&
        typeof body === "object" &&
        !body.error &&
        !body.code
      )
        return body;
    } catch {
      // Never log token responses or fetch request options through auth errors.
    }
    throw new Error("Lark authentication unavailable.");
  }
  function post(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  return {
    providerId: "lark",
    clientId: config.appId,
    clientSecret: config.secret,
    name: "Lark",
    authorizationUrl:
      "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
    tokenUrl: `${API}/authen/v2/oauth/token`,
    redirectURI,
    pkce: true,
    scopes: [],
    async getToken({ code, codeVerifier, redirectURI: actualRedirect }) {
      if (!code || !codeVerifier || actualRedirect !== redirectURI)
        throw new Error("Invalid Lark authorization.");
      const tokens = await json(
        "/authen/v2/oauth/token",
        post({
          grant_type: "authorization_code",
          client_id: config.appId,
          client_secret: config.secret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectURI,
        }),
      );
      if (typeof tokens.access_token !== "string" || !tokens.access_token)
        throw new Error("Lark token unavailable.");
      // No offline/refresh grant: every new staff sign-in rechecks live identity.
      return { accessToken: tokens.access_token };
    },
    async getUserInfo(tokens) {
      if (!tokens.accessToken) return null;
      const result = await json("/authen/v1/user_info", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const profile = result.data;
      if (
        !profile ||
        profile.tenant_key !== config.tenant ||
        !OPEN_ID.test(profile.open_id ?? "")
      )
        return null;
      const app = await json(
        "/auth/v3/tenant_access_token/internal",
        post({ app_id: config.appId, app_secret: config.secret }),
      );
      if (
        typeof app.tenant_access_token !== "string" ||
        !app.tenant_access_token
      )
        return null;
      const headers = { Authorization: `Bearer ${app.tenant_access_token}` };
      const directory = await json(
        `/contact/v3/users/${encodeURIComponent(profile.open_id)}?user_id_type=open_id`,
        { headers },
      );
      const person = directory.data?.user;
      const status = person?.status;
      if (
        person?.open_id !== profile.open_id ||
        (person.tenant_key && person.tenant_key !== config.tenant) ||
        status?.is_activated !== true ||
        status.is_exited ||
        status.is_frozen ||
        status.is_resigned ||
        status.is_unjoin
      )
        return null;
      // Only the enterprise-managed mailbox may bind an existing Harly account.
      // Personal profile email and display names never authorize account linking.
      const email =
        typeof person.enterprise_email === "string"
          ? person.enterprise_email.trim().toLowerCase()
          : "";
      if (
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
        (profile.enterprise_email &&
          profile.enterprise_email.trim().toLowerCase() !== email)
      )
        return null;
      const visibility = await json(
        `/application/v6/applications/${encodeURIComponent(config.appId)}/visibility/check_white_black_list?user_id_type=open_id`,
        {
          ...post({ user_ids: [profile.open_id] }),
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
      const list = visibility.data?.user_visibility_list;
      if (!Array.isArray(list)) return null;
      const entries = list.filter((entry) => entry.user_id === profile.open_id);
      if (
        entries.length !== 1 ||
        entries[0].in_white_list !== true ||
        entries[0].in_black_list !== false
      )
        return null;
      const identity = {
        subject: `${config.appId}:${config.tenant}:${profile.open_id}`,
        openId: profile.open_id,
        email,
        name:
          typeof profile.name === "string" && profile.name
            ? profile.name
            : email,
      };
      if (!(await authorize(identity))) return null;
      return {
        id: identity.subject,
        email,
        emailVerified: true,
        name: identity.name,
      };
    },
  };
}
