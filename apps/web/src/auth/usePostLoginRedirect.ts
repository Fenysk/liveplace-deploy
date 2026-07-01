/**
 * Post-login own-canvas redirect hook — case B (FEN-1472 / S2 of FEN-1462).
 *
 * Consumes the POSTLOGIN_OWNCANVAS_KEY flag once at mount, then watches the
 * Better Auth session + Convex auth:me query and returns a verdict each render.
 * The pure resolver (resolvePostLoginOwnCanvas) lives in returnTo.ts so it can
 * be unit-tested without browser dependencies.
 *
 * Callers (Router in router.tsx) execute side effects:
 *   redirect  → replace(verdict.path)          [AC5]
 *   fallback  → neutral info toast, stay at /  [Q3]
 */
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { authClient } from "./auth-client.js";
import {
  consumePostLoginOwnCanvas,
  resolvePostLoginOwnCanvas,
  type PostLoginOwnCanvasVerdict,
} from "./returnTo.js";

export type { PostLoginOwnCanvasVerdict };

/** auth:me → personalCanvasSlug for the current user (or null / loading). */
const meRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { personalCanvasSlug: string | null } | null
>("auth:me");

/**
 * Reactive hook — consumes the own-canvas flag once at mount, then tracks
 * session + me until the verdict settles. Stable across re-renders via useMemo.
 */
export function usePostLoginRedirect(): PostLoginOwnCanvasVerdict {
  // useState initializer runs exactly once — consumes the flag before any
  // re-render can run it again (safe in StrictMode double-mount as well).
  const [flagConsumed] = useState(() => consumePostLoginOwnCanvas());
  const { data: session, isPending } = authClient.useSession();
  const me = useQuery(meRef, {});

  return useMemo(
    () =>
      resolvePostLoginOwnCanvas({
        flagConsumed,
        session: session ?? null,
        isPending,
        me,
      }),
    [flagConsumed, session, isPending, me],
  );
}
