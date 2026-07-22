/**
 * /studio/broadcast/$slug → redirect /studio (FEN-1217, FEN-2098 T3).
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/studio/broadcast/$slug")({
  beforeLoad: () => {
    throw redirect({ to: "/studio" });
  },
});
