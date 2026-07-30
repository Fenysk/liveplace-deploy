/**
 * Convex scheduled jobs (FEN-1868).
 *
 * - twitchLive.refreshAll: poll Helix Get Streams every 60s and write
 *   stream-status transitions into `streamStatus`. Any failure degrades
 *   silently to twitchLive=false (A7).
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "refresh-twitch-live-status",
  { seconds: 60 },
  internal.twitchLive.UNAUTH_refreshAll,
  {},
);

export default crons;
