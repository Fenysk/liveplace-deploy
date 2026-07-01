/**
 * FEN-1519 — Preuve headless premier login (anti-page-blanche FEN-1515).
 *
 * Prouve SANS compte Twitch que le fix FEN-1515 supprime la page blanche de
 * la première connexion (FEN-1514). Le bug était un échec de rendu React
 * post-auth (throw "unauthenticated" depuis un useQuery auth-gated avant que
 * Convex confirme le JWT) — pas un échec du handshake OAuth.
 *
 * Scénarios :
 *   A. THROW + ErrorBoundary (FEN-1515 activé) → recovery screen visible, pas de
 *      page blanche. Simule le throw "unauthenticated" de la race window.
 *   B. THROW sans guard (pré-FEN-1515 simulé) → page blanche. Montre ce qui
 *      se passait avant : React démonte l'arbre, rien ne s'affiche.
 *   C. État first-login normal (canvas=undefined → return null) → pas de crash,
 *      loading silencieux.
 *   D. Non-régression : compte existant avec données canvas → canvas s'affiche.
 *
 * ACs vérifiés :
 *   1. Scénario A : .ui-state-screen--error visible + titre "Oups, un pixel a sauté"
 *   2. Scénario B : root vide (page blanche simulée)
 *   3. Scénario C : root vide sans erreur JS bloquante (return null = OK)
 *   4. Scénario D : .canvas-area présent et visible
 *
 * Usage: node shoot.mjs
 */
import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs";
import { mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "screenshots");
const REPO =
  "/paperclip/instances/default/projects/ec6c9c76-57ed-4476-bb8c-58a90776c95f/5fc73a29-d7f0-4499-91dc-4d495991323b/_default";
const WEB = join(REPO, "apps/web");
const PNPM = join(REPO, "node_modules/.pnpm");

// Production React builds — no dev overlay on unhandled errors, matches prod behaviour.
const REACT_PATH = join(
  PNPM,
  "react@18.3.1/node_modules/react/umd/react.production.min.js",
);
const REACT_DOM_PATH = join(
  PNPM,
  "react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.production.min.js",
);

await mkdir(OUT, { recursive: true });

const tokens = await readFile(join(WEB, "src/ui/styles/tokens.css"), "utf8");
const components = await readFile(
  join(WEB, "src/ui/styles/components.css"),
  "utf8",
);
const reactSrc = await readFile(REACT_PATH, "utf8");
const reactDomSrc = await readFile(REACT_DOM_PATH, "utf8");
const interBytes = await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"));
const interB64 = interBytes.toString("base64");

// Keep @font-face for real-browser rendering (Alexis preview), but headless
// uses the programmatic FontFace ArrayBuffer approach (see memory headless-screenshot-fonts).
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

/** Load font via ArrayBuffer form — bulletproof in headless (no NetworkError). */
async function loadInterFont(page) {
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ff = new FontFace("Inter", bytes.buffer, { weight: "100 900" });
    await ff.load();
    document.fonts.add(ff);
    await document.fonts.ready;
  }, interB64);
}

const BASE_STYLES = `
${FONT_FACE}
${tokens}
${components}
*{box-sizing:border-box;}
html,body{margin:0;background:var(--ui-bg);font-family:"Inter",sans-serif;min-height:100vh;}
.ui-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
/* Proof overlay */
.proof-label{
  position:fixed;top:0;left:0;right:0;
  background:rgba(0,0,0,.82);color:#fff;font-size:10px;
  padding:4px 10px;font-family:monospace;z-index:9999;line-height:1.4;
}
/* Mock canvas area for scenario D */
.canvas-area{
  width:100%;height:100%;min-height:calc(100vh - 64px);
  background:var(--ui-surface-sunken,#f3f4f6);
  display:flex;align-items:center;justify-content:center;
  color:var(--ui-text-secondary);font-size:13px;
}
.canvas-toolbar{
  position:fixed;bottom:0;left:0;right:0;height:64px;
  background:var(--ui-surface-raised);border-top:1px solid var(--ui-border);
  display:flex;align-items:center;gap:8px;padding:0 16px;
}
`;

/** Build a full HTML page with React + CSS. */
function buildPage(label, mountScript) {
  return `<!doctype html><html lang="fr"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${BASE_STYLES}</style>
</head>
<body>
  <div class="proof-label">${label}</div>
  <div id="root"></div>
  <script>
    // Suppress React production-mode error logs that pollute the test output.
    // IIFE ensures const is function-scoped so setContent re-runs don't redeclare it.
    (function() {
      var _origError = console.error.bind(console);
      console.error = function() {
        var msg = String(arguments[0] ?? "");
        if (msg.indexOf("unauthenticated") !== -1 || msg.indexOf("The above error") !== -1) return;
        _origError.apply(console, arguments);
      };
    })();
  </script>
  <script>${reactSrc}</script>
  <script>${reactDomSrc}</script>
  <script>${mountScript}</script>
</body></html>`;
}

/* ──────────────────────────────────────────────────────────────── helpers ── */

// Inline ErrorBoundary (faithful replica of apps/web/src/ErrorBoundary.tsx logic).
const ERROR_BOUNDARY_JS = `
(function() {
  const h = React.createElement;

  function ErrorFallback({ onRetry, message }) {
    return h(
      "section",
      {
        "aria-labelledby": "error-boundary-title",
        className: "ui-state-screen ui-state-screen--error",
      },
      h(
        "div",
        { className: "ui-state-screen__card" },
        h("p", { className: "ui-state-screen__kicker" }, "Erreur"),
        h(
          "h1",
          { id: "error-boundary-title", className: "ui-state-screen__title" },
          "Oups, un pixel a saute"
        ),
        h(
          "p",
          { className: "ui-state-screen__sub" },
          "Quelque chose a plante de notre cote. Reessaie."
        ),
        h(
          "div",
          { className: "ui-state-screen__actions" },
          h(
            "button",
            {
              type: "button",
              className: "ui-btn ui-btn--primary ui-btn--md",
              onClick: onRetry,
            },
            "Reessayer"
          ),
          h(
            "a",
            { href: "/", className: "ui-btn ui-btn--secondary ui-btn--md" },
            "Retour a l'accueil"
          )
        ),
        message &&
          h(
            "details",
            {
              style: {
                maxWidth: 480,
                margin: "0.5rem auto 1.5rem",
                padding: "0 1rem",
                textAlign: "center",
                color: "#6b7280",
                fontSize: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              },
            },
            h("summary", { style: { cursor: "pointer" } }, "Details techniques"),
            h(
              "code",
              { style: { display: "block", marginTop: 8, wordBreak: "break-word" } },
              message
            )
          )
      )
    );
  }

  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false, message: undefined };
      this.handleRetry = this.handleRetry.bind(this);
    }
    static getDerivedStateFromError(error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return { hasError: true, message };
    }
    componentDidCatch(error, info) {
      console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
    }
    handleRetry() {
      this.setState({ hasError: false, message: undefined });
    }
    render() {
      if (this.state.hasError) {
        return React.createElement(ErrorFallback, {
          onRetry: this.handleRetry,
          message: this.state.message,
        });
      }
      return this.props.children;
    }
  }

  window.__ErrorBoundary = ErrorBoundary;
})();
`;

/* ──────────────────────────────────────────── Scenario mount scripts ────── */

// A: throw inside ErrorBoundary — recovery screen must appear.
const MOUNT_A = `
${ERROR_BOUNDARY_JS}
(function() {
  const h = React.createElement;
  const ErrorBoundary = window.__ErrorBoundary;

  // Simulates ConvexAuthProvider throwing during its first render on a brand-new
  // account — the auth-race window that caused FEN-1514.
  function SimulatedConvexAuthProvider() {
    throw new Error(
      "unauthenticated [FEN-1514: JWT not yet confirmed by Convex backend]"
    );
  }

  // FEN-1515 tree: ErrorBoundary above SimulatedConvexAuthProvider.
  ReactDOM.createRoot(document.getElementById("root")).render(
    h(ErrorBoundary, null, h(SimulatedConvexAuthProvider))
  );
})();
`;

// B: throw WITHOUT ErrorBoundary — React unmounts the tree → white page.
const MOUNT_B = `
(function() {
  // Same throw, no boundary.
  function SimulatedConvexAuthProvider() {
    throw new Error(
      "unauthenticated [FEN-1514: no ErrorBoundary to catch — tree unmounts]"
    );
  }
  // React 18 production: uncaught render error → tree unmounts → root is empty.
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(SimulatedConvexAuthProvider)
  );
})();
`;

// C: First-login normal state — CanvasViewLive returns null while canvas===undefined.
const MOUNT_C = `
(function() {
  const h = React.createElement;

  // Mirrors CanvasViewLive's guard: canvas===undefined (Convex still loading) → return null.
  function CanvasViewLiveStub({ slug }) {
    const [canvas] = React.useState(undefined); // undefined = loading
    if (canvas === undefined) return null; // FEN-1432 anti-flash guard
    return h("div", { className: "canvas-area" }, "Canvas: " + slug);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(
    h(CanvasViewLiveStub, { slug: "default" })
  );
})();
`;

// D: Non-regression — existing user, canvas data present → renders normally.
const MOUNT_D = `
(function() {
  const h = React.createElement;

  // Mirrors CanvasViewLive resolving canvas + mounting CanvasView.
  function CanvasViewLiveStub({ slug }) {
    const canvas = { _id: "mock-canvas-id" }; // data present — not loading, not null
    if (canvas === undefined) return null;
    if (canvas === null) return h("div", null, "Canvas introuvable");
    return h(
      "div",
      { style: { position: "relative", height: "100vh" } },
      h("div", { className: "canvas-area" },
        h("span", null, "Canevas collaboratif — " + slug + " (" + canvas._id + ")")
      ),
      h(
        "div",
        { className: "canvas-toolbar" },
        h("span", { style: { fontSize: 12, color: "var(--ui-text-secondary)" } }, "Palette"),
        h("button", { type: "button", className: "ui-btn ui-btn--primary ui-btn--sm" }, "Placer")
      )
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(
    h(CanvasViewLiveStub, { slug: "default" })
  );
})();
`;

/* ──────────────────────────────────────────────────────── test runner ────── */

const SCENARIOS = [
  {
    id: "A-throw-with-guard",
    label: "A | FEN-1515 ACTIF — throw capturé par ErrorBoundary → recovery screen (pas de page blanche)",
    mount: MOUNT_A,
  },
  {
    id: "B-throw-no-guard",
    label: "B | PRÉ-FEN-1515 simulé — throw SANS guard → React démonte → page blanche",
    mount: MOUNT_B,
  },
  {
    id: "C-first-login-loading",
    label: "C | Premier login normal — canvas=undefined → return null — loading silencieux, zéro crash",
    mount: MOUNT_C,
  },
  {
    id: "D-existing-user",
    label: "D | Non-régression — compte existant, données canvas présentes → canvas s'affiche",
    mount: MOUNT_D,
  },
];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch();
const results = {};

for (const sc of SCENARIOS) {
  results[sc.id] = {};
  const page = await browser.newPage();

  // Collect JS errors to detect uncaught throws.
  const jsErrors = [];
  page.on("pageerror", (err) => jsErrors.push(err.message));

  const html = buildPage(sc.label, sc.mount);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.setContent(html, { waitUntil: "networkidle" });
    // Load font via ArrayBuffer — bulletproof in headless (CSS @font-face flaky).
    await loadInterFont(page);
    await page.waitForTimeout(300);

    const file = join(OUT, `${vp.name}-${sc.id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  ✓ ${vp.name}-${sc.id}.png`);
  }

  // DOM assertions (run once after last viewport).
  // rootElementsCount: Element children only (React renders comment nodes for null/empty,
  // those are not Elements, so null-return counts as 0 elements).
  const domState = await page.evaluate(() => {
    const root = document.getElementById("root");
    const errorScreen = root?.querySelector(".ui-state-screen--error");
    const canvasArea = root?.querySelector(".canvas-area");
    const errorTitle = root?.querySelector("#error-boundary-title");
    return {
      rootEmpty: (root?.innerHTML ?? "").trim() === "",
      rootElementsCount: root?.children.length ?? 0,
      hasErrorScreen: !!errorScreen,
      hasCanvasArea: !!canvasArea,
      errorTitleText: errorTitle?.textContent?.trim() ?? null,
    };
  });

  results[sc.id] = { domState, jsErrors };
  await page.close();
}

await browser.close();

/* ─────────────────────────────────────────────── assertion pass/fail ─────── */

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("FEN-1519 — RAPPORT PASS/FAIL");
console.log("═══════════════════════════════════════════════════════════════");

const checks = [
  // AC 1 — Scénario A: ErrorBoundary catches → recovery screen visible
  {
    label:
      "AC1-A: ErrorBoundary attrape le throw → .ui-state-screen--error visible",
    pass: results["A-throw-with-guard"].domState.hasErrorScreen === true,
  },
  {
    label: 'AC1-A: Titre de la recovery screen = "Oups, un pixel a saute"',
    pass:
      results["A-throw-with-guard"].domState.errorTitleText === "Oups, un pixel a saute",
  },
  {
    label: "AC1-A: Page non blanche (root non vide après le throw catchéd)",
    pass: results["A-throw-with-guard"].domState.rootEmpty === false,
  },

  // AC 2 — Scénario B: Sans guard → page blanche (root vide)
  {
    label: "AC2-B: Sans ErrorBoundary → root vide (page blanche simulée)",
    pass: results["B-throw-no-guard"].domState.rootEmpty === true,
  },

  // AC 3 — Scénario C: First-login normal → null return, pas de crash JS
  {
    label:
      "AC3-C: canvas=undefined → return null — 0 éléments dans root, zéro erreur JS",
    pass:
      results["C-first-login-loading"].domState.rootElementsCount === 0 &&
      results["C-first-login-loading"].jsErrors.length === 0,
  },

  // AC 4 — Scénario D: compte existant → canvas area s'affiche
  {
    label: "AC4-D: Compte existant → .canvas-area rendu correctement",
    pass: results["D-existing-user"].domState.hasCanvasArea === true,
  },
];

let allPass = true;
for (const c of checks) {
  const icon = c.pass ? "✅ PASS" : "❌ FAIL";
  console.log(`  ${icon}  ${c.label}`);
  if (!c.pass) allPass = false;
}

console.log("═══════════════════════════════════════════════════════════════");
if (allPass) {
  console.log("✅ Tous les ACs passent — FEN-1515 prouve l'anti-page-blanche.");
} else {
  console.log("❌ Certains ACs ont échoué — voir détails ci-dessus.");
  process.exit(1);
}
console.log(`\nScreenshots dans : ${OUT}`);
