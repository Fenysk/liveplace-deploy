/**
 * Outreach funnel attribution (FEN-242) — minimal, UI-independent.
 *
 * Gate-2 of the outreach DM probe (FEN-240): the CMO must not be blind on
 * response → visit → signup. This is the strict minimum to see that — no
 * analytics platform, no dashboard, no new login-wall.
 *
 * Capture is entirely backend so it cannot collide with the upcoming Arcade
 * frontend refonte (that was the code-conflict concern). The DM links are plain
 * tracked URLs pointing at the gateway:
 *
 *   1. VISIT  — the DM link is `https://liveplace.tv/r?ref=XYZ`. The gateway
 *      counts the visit, drops a short first-party `lp_ref` cookie, and 302s the
 *      visitor to the site. No frontend involved.
 *   2. SIGNUP — when that visitor later authenticates, the SPA opens the WS to
 *      the SAME origin (`wss://liveplace.tv/ws`), so the browser replays the
 *      `lp_ref` cookie on the upgrade request. The gateway already knows the
 *      `userId` (JWT `sub`) there, so it attributes the user to `ref` with no
 *      frontend change and no Convex/auth touch. First ref wins per user
 *      (HSETNX), so a user is counted once.
 *   3. REPORT — `GET /r/report` (Bearer internal secret) returns visits +
 *      signups per ref as JSON.
 *
 * SIGNUP semantics (directional probe, intentional): "signups" counts the
 * DISTINCT authenticated users attributed to a ref — i.e. a user who arrived via
 * `ref=XYZ` and then signed in. For a cold-outreach batch (recipients who don't
 * have an account yet) this is signups; a pre-existing user who happens to click
 * a tracked link and log in is rare and acceptable noise for a 24-DM directional
 * probe (we deliberately do not over-build a multi-step funnel — CEO decision).
 *
 * Redis keys live under a dedicated `attr:` namespace, additive and disjoint
 * from the frozen canvas hot-path keys (`canvas:*`).
 */

/** The narrow Redis surface the attribution store needs (ioredis satisfies it). */
export interface AttributionRedis {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  sadd(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
}

const REFS_KEY = "attr:refs";
// USERREF_KEY / signupsKey are exported for the account purge (FEN-1966):
// deleting an account must unpin the user from `attr:userref` and remove them
// from their ref's signup set, from the same single source of key names.
export const USERREF_KEY = "attr:userref";
const visitsKey = (ref: string) => `attr:visits:${ref}`;
export const signupsKey = (ref: string) => `attr:signups:${ref}`;

/** One row of the funnel report. */
export interface AttributionRow {
  ref: string;
  visits: number;
  signups: number;
}

/**
 * Maximum ref length we persist. Refs are campaign labels (`batch1-a`, a DM id),
 * not free text; capping bounds key size and the SCAN-free `attr:refs` set.
 */
const MAX_REF_LEN = 64;

/**
 * Normalise an inbound `ref` to a safe, canonical key: lowercase, only
 * `[a-z0-9_-]`, capped length. Returns `null` for anything empty/invalid so the
 * redirect still works (we just don't attribute a junk ref). This also keeps the
 * value safe to embed in a `Set-Cookie` (no control chars / separators).
 */
export function sanitizeRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (cleaned === "") return null;
  return cleaned.slice(0, MAX_REF_LEN);
}

/** Pull the `lp_ref` value out of a raw `Cookie:` header, sanitized. */
export function readRefCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "lp_ref") continue;
    return sanitizeRef(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

/**
 * Funnel counters in Redis. Each method is independently idempotent enough for a
 * directional probe: visits are raw click counts (INCR); signups are deduped per
 * user via a first-write-wins hash so a reconnecting user is never double-counted.
 */
export class AttributionStore {
  constructor(private readonly redis: AttributionRedis) {}

  /** Count a tracked visit for `ref` (a DM link click). */
  async recordVisit(ref: string): Promise<void> {
    await this.redis.sadd(REFS_KEY, ref);
    await this.redis.incr(visitsKey(ref));
  }

  /**
   * Attribute an authenticated user to `ref`. First ref wins (HSETNX): a user is
   * pinned to the first campaign they arrived through and counted exactly once,
   * so repeated reconnects / multiple tabs never inflate the signup count.
   */
  async recordSignup(userId: string, ref: string): Promise<void> {
    const isFirst = await this.redis.hsetnx(USERREF_KEY, userId, ref);
    if (isFirst !== 1) return; // already attributed (idempotent)
    await this.redis.sadd(REFS_KEY, ref);
    await this.redis.sadd(signupsKey(ref), userId);
  }

  /** Visits + signups per ref, sorted by ref for stable reading. */
  async report(): Promise<AttributionRow[]> {
    const refs = await this.redis.smembers(REFS_KEY);
    const rows = await Promise.all(
      refs.map(async (ref) => {
        const [visitsRaw, signups] = await Promise.all([
          this.redis.get(visitsKey(ref)),
          this.redis.scard(signupsKey(ref)),
        ]);
        return { ref, visits: visitsRaw ? Number(visitsRaw) || 0 : 0, signups };
      }),
    );
    return rows.sort((a, b) => a.ref.localeCompare(b.ref));
  }
}

/** Build the `Set-Cookie` value pinning the visitor to `ref`. */
export function buildRefCookie(
  ref: string,
  opts: { maxAgeSec: number; secure: boolean },
): string {
  const attrs = [
    `lp_ref=${encodeURIComponent(ref)}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
