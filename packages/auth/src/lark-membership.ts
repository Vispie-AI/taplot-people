import { and, eq, gt, sql } from "drizzle-orm";
import { db, account, invitation, member, organization, user } from "@harly/db";
import type { LarkIdentity } from "./lark";

/** A verified enterprise identity still needs an active Harly membership or email invite. */
export async function authorizeLarkMember(
  identity: LarkIdentity,
): Promise<boolean> {
  const organizations = await db
    .select({ id: organization.id })
    .from(organization)
    .limit(2);
  if (organizations.length !== 1) return false;
  const orgId = organizations[0]!.id;
  const bound = await db
    .select({ userId: account.userId })
    .from(account)
    .where(
      and(
        eq(account.providerId, "lark"),
        eq(account.accountId, identity.subject),
      ),
    )
    .limit(2);
  if (bound.length > 1) return false;
  let userId = bound[0]?.userId;
  if (!userId) {
    const matches = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.email})`, identity.email))
      .limit(2);
    if (matches.length > 1) return false;
    userId = matches[0]?.id;
    if (userId) {
      const otherBinding = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.providerId, "lark"), eq(account.userId, userId)))
        .limit(1);
      // A recycled mailbox or changed Lark app cannot take over an existing binding.
      if (otherBinding.length) return false;
    }
  }
  if (userId) {
    const memberships = await db
      .select({ status: member.status })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
      .limit(1);
    if (memberships.length) return memberships[0]!.status === "active";
  }
  const invites = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(sql`lower(${invitation.email})`, identity.email),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invites.length === 1;
}
