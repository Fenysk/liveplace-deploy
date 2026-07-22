#!/usr/bin/env node
/**
 * scripts/lib/deploy-fingerprint.mjs — make the FEN-1580 design-clobber detectable
 * before a bundle can reach prod.
 *
 * The recurrence (FEN-1580 → FEN-1596 → FEN-1625): a deploy built from the neutral
 * **S0** UI layer strips the neobrutalism design. S0 vs. design is visible in one
 * primitive in apps/web/src/ui/styles/tokens.css — the elevation tokens:
 *
 *   design  (neobrutalism):  --elev-1: 2px 2px 0 0 var(--ink);   (hard offset shadow)
 *   neutral (S0, clobber):   --elev-1: none;
 *
 * `--elev-1: none` in the bundled CSS is therefore a deterministic fingerprint of
 * "the design was stripped." This guard throws on it, loudly, before the deploy push.
 *
 * Convention: see docs/adr/0007-deploy-lineage-convergence-anticlobber.md.
 * Primary protection is lineage convergence (main carries the design); this is
 * defense-in-depth on the scripted bundle path.
 *
 * ZERO npm deps. Self-test: `node scripts/lib/deploy-fingerprint.mjs --selftest`.
 */

/** The elevation token that flips to `none` when the design is stripped. */
export const FINGERPRINT_TOKEN = "--elev-1";

export class DesignFingerprintError extends Error {
  constructor(message) {
    super(message);
    this.name = "DesignFingerprintError";
  }
}

/**
 * Read the last declared value of a CSS custom property from raw CSS text.
 * Returns the trimmed value (without the trailing `;`), or null if never declared.
 * "Last declared" matches the cascade — a later `:root` override wins.
 */
export function readCssVar(cssText, name) {
  if (typeof cssText !== "string") return null;
  // Match `--name: <value>;` — value is everything up to the first `;` or `}`.
  const re = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;}]*)`, "g");
  let last = null;
  let m;
  while ((m = re.exec(cssText)) !== null) last = m[1].trim();
  return last;
}

/**
 * Throw if `cssText` looks like the neutral S0 layer (design stripped).
 * The check: the elevation fingerprint token must be *declared* and must not be
 * `none`. Absent OR `none` → refuse.
 *
 * @param {string} cssText  raw contents of the bundled tokens.css
 * @param {{ source?: string }} [opts]  label for the error message
 */
export function assertDesignFingerprint(cssText, opts = {}) {
  const source = opts.source ?? "bundled tokens.css";
  const value = readCssVar(cssText, FINGERPRINT_TOKEN);

  if (value === null) {
    throw new DesignFingerprintError(
      `Design fingerprint MISSING in ${source}: ${FINGERPRINT_TOKEN} is not ` +
        `declared. Refusing to deploy — this is not the design lineage. ` +
        `See docs/adr/0007.`,
    );
  }
  if (value.toLowerCase() === "none") {
    throw new DesignFingerprintError(
      `Design CLOBBER detected in ${source}: ${FINGERPRINT_TOKEN}: none ` +
        `(neutral S0 layer). Refusing to deploy — this would strip the ` +
        `neobrutalism design (FEN-1580). Deploy from the converged main ` +
        `lineage. See docs/adr/0007.`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ self-test */

function selftest() {
  const cases = [
    // [label, cssText, shouldThrow]
    ["design neobrutalism", ":root{ --elev-1: 2px 2px 0 0 var(--ink); }", false],
    ["design, later override still design", ":root{--elev-1:none}:root{--elev-1:4px 4px 0 0 #000}", false],
    ["neutral S0 clobber", ":root{ --elev-1: none; }", true],
    ["neutral S0, uppercase NONE", ":root{ --elev-1: NONE; }", true],
    ["neutral wins via cascade", ":root{--elev-1:2px 2px 0 0 #000}:root{--elev-1:none}", true],
    ["token absent entirely", ":root{ --radius-sm: 0; }", true],
    ["not a string", null, true],
    ["real-ish design block", "--radius-xs:0;--elev-1: 2px 2px 0 0 var(--ink);--elev-2: 4px 4px 0 0 var(--ink);", false],
  ];

  let pass = 0;
  let fail = 0;
  for (const [label, css, shouldThrow] of cases) {
    let threw = false;
    try {
      assertDesignFingerprint(css, { source: label });
    } catch (e) {
      threw = e instanceof DesignFingerprintError;
      if (!threw) {
        console.error(`  ✗ ${label}: threw wrong error type: ${e}`);
        fail++;
        continue;
      }
    }
    if (threw === shouldThrow) {
      console.log(`  ✓ ${label}${shouldThrow ? " (refused)" : " (allowed)"}`);
      pass++;
    } else {
      console.error(`  ✗ ${label}: expected ${shouldThrow ? "refuse" : "allow"}, got ${threw ? "refuse" : "allow"}`);
      fail++;
    }
  }
  console.log(`\ndeploy-fingerprint self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("deploy-fingerprint.mjs") && process.argv.includes("--selftest")) {
  selftest();
}
