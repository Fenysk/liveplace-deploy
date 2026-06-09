/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as canvases from "../canvases.js";
import type * as gallery from "../gallery.js";
import type * as http from "../http.js";
import type * as lib_canvasRules from "../lib/canvasRules.js";
import type * as lib_gallery from "../lib/gallery.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_leaderboard from "../lib/leaderboard.js";
import type * as lib_moderation from "../lib/moderation.js";
import type * as lib_placementAggregate from "../lib/placementAggregate.js";
import type * as lib_pointsRules from "../lib/pointsRules.js";
import type * as lib_publicProfile from "../lib/publicProfile.js";
import type * as moderation from "../moderation.js";
import type * as palettes from "../palettes.js";
import type * as points from "../points.js";
import type * as profiles from "../profiles.js";
import type * as stats from "../stats.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  canvases: typeof canvases;
  gallery: typeof gallery;
  http: typeof http;
  "lib/canvasRules": typeof lib_canvasRules;
  "lib/gallery": typeof lib_gallery;
  "lib/identity": typeof lib_identity;
  "lib/leaderboard": typeof lib_leaderboard;
  "lib/moderation": typeof lib_moderation;
  "lib/placementAggregate": typeof lib_placementAggregate;
  "lib/pointsRules": typeof lib_pointsRules;
  "lib/publicProfile": typeof lib_publicProfile;
  moderation: typeof moderation;
  palettes: typeof palettes;
  points: typeof points;
  profiles: typeof profiles;
  stats: typeof stats;
  worker: typeof worker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
