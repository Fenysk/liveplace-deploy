import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

// LivePlace durable app. The Better Auth component owns the auth tables
// (user / account / session / verification, with Twitch tokens stored
// server-side and encrypted). Our app schema only holds the application
// `profiles` table — see schema.ts. ADR: docs/contracts/auth-flow.md.
const app = defineApp();
app.use(betterAuth);

export default app;
