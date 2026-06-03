/**
 * FEN-98 deployment-env diagnostic.
 *
 * Better Auth runs INSIDE Convex; it derives its signing secret from
 * `process.env.BETTER_AUTH_SECRET` (or `AUTH_SECRET`). On self-hosted Convex
 * those vars live in the *deployment* env (pushed by `apps/convex/deploy.sh`
 * via `convex env set`), NOT the backend container's OS env. When the secret is
 * absent the functions runtime falls back to a hard-coded default and Better
 * Auth throws `BetterAuthError: You are using the default secret`.
 *
 * This query reports, for the Convex functions runtime that actually serves
 * requests, whether that secret arrived plus which of the seeded deployment env
 * vars are present. It returns env var NAMES and a coarse set/DEFAULT flag ONLY
 * — never any value — so it is safe to expose publicly while we diagnose the
 * auth-ON rollout. It is the clean cut between the three failure hypotheses:
 *   - `betterAuthSecret: "DEFAULT"` + name missing  => seed never reached the
 *     deployment (container .env incomplete, or `convex env set` failed);
 *   - `betterAuthSecret: "set"` but auth still fails => a read/config bug, not
 *     a seeding bug.
 *
 * Remove once auth-ON is hardened (FEN-98).
 */
import { query } from "./_generated/server";

/**
 * The deployment env vars `apps/convex/deploy.sh` is responsible for seeding,
 * plus `AUTH_SECRET` (Better Auth's secondary secret source). Names only — used
 * purely to report presence, never to echo a value.
 */
const SEEDED_ENV_NAMES = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "AUTH_SECRET",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "GATEWAY_INTERNAL_SECRET",
  "GATEWAY_INTERNAL_URL",
] as const;

export const authEnvStatus = query({
  args: {},
  handler: async (): Promise<{
    betterAuthSecret: "set" | "DEFAULT";
    present: string[];
    missing: string[];
    seedReport: string | null;
  }> => {
    const present: string[] = [];
    const missing: string[] = [];
    for (const name of SEEDED_ENV_NAMES) {
      const value = process.env[name];
      (value !== undefined && value !== "" ? present : missing).push(name);
    }
    // Mirror Better Auth's own secret resolution order (BETTER_AUTH_SECRET, then
    // AUTH_SECRET); "set" means functions WILL sign JWTs with a real secret.
    const secret = process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
    return {
      betterAuthSecret: secret ? "set" : "DEFAULT",
      present, // names only — NEVER values
      missing,
      // FEN-98: deploy.sh's per-name seed DECISION for THIS functions runtime,
      // as "NAME:set,NAME:UNSET,…" (names + coarse flag only, never values).
      // Disambiguates "BETTER_AUTH_SECRET empty in the convex-deploy container"
      // (env_file/Coolify gap) from "convex env set dropped it". null until the
      // deploy.sh that publishes it has run.
      seedReport: process.env.DIAG_SEED_REPORT ?? null,
    };
  },
});
