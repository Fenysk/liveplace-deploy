/// <reference types="vite/client" />

// Public (browser-exposed) Convex URLs. Safe to ship to the client — no secrets.
interface ImportMetaEnv {
  /** Convex client/API URL (queries, mutations, actions). */
  readonly VITE_CONVEX_URL: string;
  /** Convex SITE URL serving the Better Auth HTTP routes (`/api/auth/*`). */
  readonly VITE_CONVEX_SITE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
