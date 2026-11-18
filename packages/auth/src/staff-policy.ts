/** Installation policy for staff authentication; candidate portal auth is separate. */
export function isLarkOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARLY_STAFF_AUTH_MODE === "lark-only";
}

export function isLarkConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env.LARK_CLIENT_ID?.trim() &&
    env.LARK_CLIENT_SECRET?.trim() &&
    env.LARK_TENANT_KEY?.trim(),
  );
}

/** Fence new sessions too, including recovery challenges from before cutover. */
export function isLarkSessionEntry(
  path: string | undefined,
  params?: Record<string, unknown>,
): boolean {
  return (
    path === "/callback/lark" ||
    (path === "/callback/:id" && params?.id === "lark")
  );
}

export function allowsLarkSessionCreation(
  path: string | undefined,
  params: Record<string, unknown> | undefined,
  userId: string,
  currentSessionUserId?: string,
): boolean {
  if (isLarkSessionEntry(path, params)) return true;
  // These native endpoints rotate an already authenticated user's session;
  // they cannot finish an old password/recovery challenge without a session.
  return (
    Boolean(currentSessionUserId) &&
    userId === currentSessionUserId &&
    [
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/verify-totp",
    ].includes(path ?? "")
  );
}

export function blocksStaffAuth(
  path: string | undefined,
  body?: Record<string, unknown>,
  params?: Record<string, unknown>,
): boolean {
  if (!path) return false;
  if (path.startsWith("/sign-in/") || path === "/link-social") {
    return !(
      (path === "/sign-in/social" || path === "/link-social") &&
      body?.provider === "lark" &&
      !body?.idToken
    );
  }
  if (path.startsWith("/callback/")) return !isLarkSessionEntry(path, params);
  return (
    path.startsWith("/sign-up/") ||
    path.startsWith("/sso/") ||
    path.startsWith("/oauth2/") ||
    path.startsWith("/magic-link/") ||
    [
      "/forget-password",
      "/request-password-reset",
      "/reset-password",
      "/change-password",
      "/set-password",
      "/change-email",
      "/unlink-account",
    ].includes(path)
  );
}
