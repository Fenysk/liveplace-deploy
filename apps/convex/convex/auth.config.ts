import type { AuthConfig } from "convex/server";

// Convex auth provider config. The Better Auth component issues JWTs signed
// with its own JWKS and validated by Convex via the OpenID config served at
// `${CONVEX_SITE_URL}/.well-known/openid-configuration` (the `convex()` plugin
// in auth.ts registers that endpoint). applicationID must be "convex".
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL as string,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
