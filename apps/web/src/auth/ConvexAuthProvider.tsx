/**
 * Wires the Convex React client to Better Auth so all Convex calls from the SPA
 * carry the authenticated user's JWT (FEN-11). Anonymous visitors still get a
 * working (unauthenticated) Convex client — they can read/watch the canvas but
 * cannot place (CA5); placement mutations check identity server-side.
 */
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { authClient } from "./auth-client";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

// One client per app load. Created at module scope so it survives re-renders.
export const convex = new ConvexReactClient(convexUrl);

export function ConvexAuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      {children}
    </ConvexBetterAuthProvider>
  );
}
