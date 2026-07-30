-- moderate.lua — atomic bulk pixel overwrite + durable stream + fan-out for the
-- moderation suite.
--
-- The single hot-path engine behind F8.1 (ban + wipe), F8.2 (targeted/group
-- delete) and F8.3 (restore "what was underneath"). All three are the same
-- operation seen from Redis: "overwrite these cells with these colours, then
-- fan out the result." The semantics (which colours — 0/white to wipe, or the
-- previous colour to restore) are decided in Convex from the durable placement
-- log; this script only applies them. The whole batch runs in ONE atomic Redis
-- script (single critical section), so no live placement can interleave a
-- half-applied wipe, and the cells either all reflect the moderation action or
-- none do.
--
-- Each overwritten cell does the SAME two things place.lua does for a placement,
-- so a moderation write is indistinguishable from an ordinary write downstream:
--   * DURABILITY — XADD the full {x,y,color,version,userId,ts} record to the
--     per-canvas stream (KEYS[3]) so the persistence worker drains it into the
--     `placements` log. This is the binding invariant from
--     docs/contracts/moderation-internal.md: without it a wipe applied between
--     worker snapshots would be lost on restore and "what was underneath" would
--     drift. The bumped `version` is echoed back so Convex can stamp it onto the
--     moderation overlay (`pixelModeration.overwriteVersion`).
--   * REALTIME — PUBLISH a "version,x,y,color" delta on the shared channel. The
--     gateway's coalescer merges every write in a flush window into ONE delta
--     frame, so a ban+wipe reaches every client as a single bulkDelta (CA1).
-- Per-write versions keep reconnect-resync (FEN-13) exact: a client replays the
-- wipe pixel-by-pixel just like ordinary writes.
--
-- A mass action SHOULD be preceded by a forced flush of the Redis→Convex
-- persistence buffer (worker), so Convex derives the cell list from an up-to-date
-- `placements` log. That ordering is the caller's responsibility (gateway/worker
-- /internal/flush), not this script's.
--
-- KEYS[1] = canvas pixels key   (string, 1 byte/pixel, row-major)
-- KEYS[2] = meta / version key  (monotonic per-canvas write sequence; fan-out + resync)
-- KEYS[3] = durable stream key  (optional; per-canvas placement stream, R2. Each
--                                overwritten cell is XADDed here as a full
--                                {x,y,color,version,userId,ts} record for the worker
--                                to drain to Convex. Omit/"" and no stream is written —
--                                e.g. unit harnesses passing only pixels+meta.)
--
-- ARGV[1] = width
-- ARGV[2] = height
-- ARGV[3] = paletteSize
-- ARGV[4] = deltaChannel        (pub/sub channel for fan-out; "" disables publish)
-- ARGV[5] = userId              (actor stamped onto each stream record; "" = system /
--                                moderation overwrite, which is what the gateway passes
--                                since the moderation HTTP seam carries no per-mod id)
-- ARGV[6] = ts                  (epoch ms stamped onto each stream record)
-- ARGV[7] = count N             (number of cells that follow)
-- ARGV[8 .. 8+3N-1] = N flattened triples: x, y, color
--
-- Returns: { applied, lastSeq }
--   applied = how many cells were actually written (invalid cells are skipped,
--             so applied < N signals a malformed batch the caller can detect)
--   lastSeq = the version of the last applied cell (0 if none applied). The
--             gateway echoes this as the response `version`.

local width       = tonumber(ARGV[1])
local height      = tonumber(ARGV[2])
local paletteSize = tonumber(ARGV[3])
local deltaChan   = ARGV[4]
local userId      = ARGV[5]
local ts          = ARGV[6]
local n           = tonumber(ARGV[7])

local applied = 0
local lastSeq = 0

for i = 0, n - 1 do
  local base  = 8 + i * 3
  local x     = tonumber(ARGV[base])
  local y     = tonumber(ARGV[base + 1])
  local color = tonumber(ARGV[base + 2])

  -- Defensive validation: skip any out-of-bounds / invalid-colour cell rather
  -- than aborting the whole action. Convex builds these from validated events,
  -- so a skip means a bug upstream — surfaced via applied < N, never a partial
  -- crash mid-wipe.
  if x ~= nil and y ~= nil and color ~= nil
     and x >= 0 and y >= 0 and x < width and y < height
     and color >= 0 and color < paletteSize then
    local offset = y * width + x
    redis.call("SETRANGE", KEYS[1], offset, string.char(color))
    local version = redis.call("INCR", KEYS[2])
    lastSeq = version
    -- DURABILITY: same record shape place.lua XADDs, so the worker drain is
    -- agnostic to whether a write came from a placement or a moderation action.
    if KEYS[3] and KEYS[3] ~= "" then
      redis.call("XADD", KEYS[3], "*",
        "x", x, "y", y, "color", color,
        "version", version, "userId", userId, "ts", ts)
    end
    -- REALTIME: ephemeral fan-out, coalesced into one bulkDelta by the gateway.
    if deltaChan ~= "" then
      redis.call("PUBLISH", deltaChan, version .. "," .. x .. "," .. y .. "," .. color)
    end
    applied = applied + 1
  end
end

return { applied, lastSeq }
