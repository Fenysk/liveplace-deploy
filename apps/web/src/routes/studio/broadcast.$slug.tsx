/**
 * /studio/broadcast/$slug → redirect /studio (FEN-1217, FEN-2098 T3).
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/studio/broadcast/$slug")({
  beforeLoad: () => {
    // replace: the legacy URL must not stay in history (Back would re-redirect).
    throw redirect({ to: "/studio", replace: true });
  },
});
