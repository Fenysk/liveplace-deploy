/**
 * Tiny env parsers shared by every service that reads numeric/boolean config.
 *
 * `num` and `bool` were copy-pasted byte-for-byte into the gateway and worker
 * `config.ts` (audit finding 1d): a single fallback/validation policy that must
 * not drift between services. They live here — next to the Redis key schema both
 * services already import — so there is one definition.
 */

/**
 * Parse `process.env[name]` as a finite number, falling back when unset/empty.
 * Throws on a present-but-non-numeric value so a typo'd env fails loudly at boot
 * rather than silently becoming NaN deep in the hot path.
 */
export function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

/** Parse a boolean env (`1`/`true`, case-insensitive), falling back when unset/empty. */
export function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}
