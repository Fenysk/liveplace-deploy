-- moderate.lua — atomic bulk pixel overwrite + fan-out for the moderation suite.
--
-- The single hot-path engine behind F8.1 (ban + wipe), F8.2 (targeted/group
-- delete) and F8.3 (restore "what was underneath"). All three are the same
-- operation seen from Redis: "overwrite these cells with these colours, then
-- fan out the result." The semantics (which colours — 0/white to wipe, or the
-- previous colour to restore) are decided in Convex from `pixelEvents`; this
-- script only applies them. The whole batch runs in ONE atomic Redis script
-- (single critical section), so no live placement can interleave a half-applied
-- wipe, and the cells either all reflect the moderation action or none do.
--
-- Each overwritten cell INCRs the shared write counter and PUBLISHes a single
-- "seq,x,y,color" delta on the same channel as place.lua. The gateway's
-- coalescer merges every write that lands within a flush window into ONE delta
-- frame, so a ban+wipe reaches every client as a single bulkDelta (CA1) with no
-- gateway change. Per-write seqs keep reconnect-resync (FEN-13) exact: a client
-- replays the wipe pixel-by-pixel just like ordinary writes.
--
-- A mass action MUST be preceded by a forced flush of the Redis→Convex
-- persistence buffer (worker), so the durable layer and the live bitmap agree on
-- the pre-wipe state before it is overwritten. That ordering is the caller's
-- responsibility (gateway/worker), not this script's.
--
-- KEYS[1] = canvas pixels key   (string, 1 byte/pixel, row-major)
-- KEYS[2] = meta / version key  (monotonic per-canvas write sequence; fan-out + resync)
--
-- NOTE (FEN-54): unlike place.lua, this script does NOT XADD to the durable
-- per-canvas stream, so a moderation overwrite applied between worker snapshots
-- is not replayed on restore. Reconciling moderation durability is a tracked
-- follow-up (ADR-0003); FEN-54 makes the placement hot path durable.
--
-- ARGV[1] = width
-- ARGV[2] = height
-- ARGV[3] = paletteSize
-- ARGV[4] = deltaChannel        (pub/sub channel for fan-out; "" disables publish)
-- ARGV[5] = count N             (number of cells that follow)
-- ARGV[6 .. 6+3N-1] = N flattened triples: x, y, color
--
-- Returns: { applied, lastSeq }
--   applied = how many cells were actually written (invalid cells are skipped,
--             so applied < N signals a malformed batch the caller can detect)
--   lastSeq = the write sequence of the last applied cell (0 if none applied)

local width       = tonumber(ARGV[1])
local height      = tonumber(ARGV[2])
local paletteSize = tonumber(ARGV[3])
local deltaChan   = ARGV[4]
local n           = tonumber(ARGV[5])

local applied = 0
local lastSeq = 0

for i = 0, n - 1 do
  local base  = 6 + i * 3
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
    local seq = redis.call("INCR", KEYS[2])
    lastSeq = seq
    if deltaChan ~= "" then
      redis.call("PUBLISH", deltaChan, seq .. "," .. x .. "," .. y .. "," .. color)
    end
    applied = applied + 1
  end
end

return { applied, lastSeq }
