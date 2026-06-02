/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 *
 * NOTE: `convex codegen` cannot currently emit the fully-typed `api` for this
 * project — bundling the Better Auth Convex component fails on a
 * `@better-auth/kysely-adapter` ↔ `kysely@0.29.2` export mismatch, so the CLI
 * falls back to the untyped `AnyApi`, which is not consumable under
 * `noUncheckedIndexedAccess`. This module is therefore authored to the standard
 * codegen template, restricted to the public read modules the web app consumes
 * (F11 profile, F12 gallery + leaderboard/stats). `canvases` is intentionally
 * omitted for now — see FEN follow-up: it trips a `DataModel`-identity TS2719
 * and a `canPlace` return-annotation widening that are out of this task's scope.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
  AnyComponents,
} from "convex/server";
import type * as gallery from "../gallery.js";
import type * as profiles from "../profiles.js";
import type * as stats from "../stats.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  gallery: typeof gallery;
  profiles: typeof profiles;
  stats: typeof stats;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: AnyComponents;
