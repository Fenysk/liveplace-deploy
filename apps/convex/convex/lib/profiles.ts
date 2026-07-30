/**
 * Shared profile lookup by Better Auth user id.
 *
 * The `by_authUserId` index query was written inline at 15 call sites across
 * 7 files (FEN-2058 / N5). This helper centralises it so any future index
 * rename or schema change only requires one edit.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * Look up the `profiles` row for a given Better Auth user id, or null when
 * the profile has not been created yet (e.g. during the brief window between
 * `user.onCreate` and `account.onCreate` in the auth trigger pipeline).
 */
export async function getProfileByAuthUserId(
  db: QueryCtx["db"],
  authUserId: string,
): Promise<Doc<"profiles"> | null> {
  return db
    .query("profiles")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
}
