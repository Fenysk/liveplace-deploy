/**
 * Auth helpers shared by the F2 mutations/queries.
 *
 * Identity comes from the Better Auth Convex component (Twitch OAuth, FEN-11).
 * Until that is wired end to end, these helpers resolve the caller from the
 * standard Convex auth identity (`ctx.auth.getUserIdentity()`), whose `subject`
 * is the Better Auth user id used as `ownerId` throughout the schema (§6.1).
 */
import type { GenericQueryCtx } from "convex/server";
import type { DataModel } from "../_generated/dataModel";

type Ctx = GenericQueryCtx<DataModel>;

/** Resolve the authenticated user id, or throw if the request is anonymous. */
export async function requireUserId(ctx: Ctx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("unauthenticated: sign in with Twitch to manage canvases.");
  }
  return identity.subject;
}

/** Resolve the authenticated user id, or null when anonymous. */
export async function optionalUserId(ctx: Ctx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.subject ?? null;
}
