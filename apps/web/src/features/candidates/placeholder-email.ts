/**
 * Placeholder addresses the BOSS import writes when BOSS withholds the real
 * email. Two generations exist in the wild:
 *  - `<sha256 of sourceRecordId>@boss.invalid` (current boss-resume-service)
 *  - `boss-<24 hex>@example.invalid` (an earlier import path)
 * Decide "is this still a placeholder?" with this helper, never by ad-hoc
 * matching, so both formats are always recognised together.
 */
const BOSS_HASH_PLACEHOLDER = /^[0-9a-f]{64}@boss\.invalid$/;
const BOSS_LEGACY_PLACEHOLDER = /^boss-[0-9a-f]{24}@example\.invalid$/;

export function isBossPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const value = email.trim().toLowerCase();
  return BOSS_HASH_PLACEHOLDER.test(value) || BOSS_LEGACY_PLACEHOLDER.test(value);
}
