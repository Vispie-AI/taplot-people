import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, account, invitation, member, organization, user } from "@harly/db";
import type { LarkIdentity } from "./lark";

/** Admit a verified Lark identity or enroll a new one under the operator policy. */
export async function authorizeLarkMember(
  identity: LarkIdentity,
  provisionAdmin = false,
): Promise<boolean> {
  if (!provisionAdmin) return checkLarkMembership(db, identity);

  return db.transaction(async (tx) => {
    // Serialize provisioning by both identity and mailbox. The two ordered
    // locks cover parallel callbacks and simultaneous directory email changes.
    const keys = [
      `harly:lark:subject:${identity.subject}`,
      `harly:lark:mail:${identity.email}`,
    ].sort();
    for (const key of keys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
    return checkLarkMembership(tx, identity, async (orgId) => {
      const userId = randomUUID();
      const now = new Date();
      const [created] = await tx
        .insert(user)
        .values({
          id: userId,
          email: identity.email,
          name: identity.name,
          emailVerified: true,
        })
        .onConflictDoNothing({ target: user.email })
        .returning({ id: user.id });
      if (!created) return false;

      await tx.insert(account).values({
        id: randomUUID(),
        accountId: identity.subject,
        providerId: "lark",
        userId,
        updatedAt: now,
      });
      await tx.insert(member).values({
        id: randomUUID(),
        organizationId: orgId,
        userId,
        role: "admin",
        createdAt: now,
      });
      return true;
    });
  });
}

export async function isLarkBoundStaffUser(userId: string): Promise<boolean> {
  const [binding] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "lark")))
    .limit(1);
  return Boolean(binding);
}

export async function isLarkBinding(accountId: string): Promise<boolean> {
  const [binding] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.providerId, "lark")))
    .limit(1);
  return Boolean(binding);
}

async function checkLarkMembership(
  storage: Pick<typeof db, "select">,
  identity: LarkIdentity,
  provision?: (organizationId: string) => Promise<boolean>,
): Promise<boolean> {
  const organizations = await storage
    .select({ id: organization.id })
    .from(organization)
    .limit(2);
  if (organizations.length !== 1) return false;
  const orgId = organizations[0]!.id;
  const bound = await storage
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
    const matches = await storage
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.email})`, identity.email))
      .limit(2);
    if (matches.length > 1) return false;
    userId = matches[0]?.id;
    if (userId) {
      const otherBinding = await storage
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.providerId, "lark"), eq(account.userId, userId)))
        .limit(1);
      // A recycled mailbox or changed Lark app cannot take over an existing binding.
      if (otherBinding.length) return false;
    }
  }
  if (userId) {
    const memberships = await storage
      .select({ status: member.status })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
      .limit(1);
    if (memberships.length) return memberships[0]!.status === "active";
    // Rejoining an existing account is an explicit membership decision.
    // Automatic enrollment is limited to new Lark identities and mailboxes.
    if (provision) return false;
  }
  if (provision) return provision(orgId);
  const invites = await storage
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
