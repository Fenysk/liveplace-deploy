-- place.lua — atomic pixel placement with the D1 charge gauge (token bucket).
--
-- The entire hot-path write, executed atomically by Redis (single threaded).
-- It is the mitigation for R1 (concurrency / cooldown bypass): the
-- refill → check → write → consume sequence cannot interleave with another
-- client's, so charges can never be raced below 0 or above the max.
--
-- Gauge mechanics are decision D1 (Product Owner). The numeric defaults
-- (gaugeMaxBase=20, refillAmount=1, refillIntervalSec=30) are canvas config,
-- passed in by the gateway — never hard-coded here. This script MIRRORS the
-- reference implementation in ../gauge.ts (refillGauge); keep them in sync.
--
-- The "gauge" (jauge) is a charge bucket: a viewer holds up to `gaugeMax` and
-- regenerates `refillAmount` every `refillIntervalMs`. A placement — coloured OR
-- eraser (color 0) — consumes 1.
--
-- `gaugeMax` is the *effective* max (canvas base + the user's upgrade bonus,
-- F6). The gateway resolves the bonus from Convex per session and passes the
-- sum here; raising it lifts the ceiling immediately (D1 CA3). The gauge hash is
-- just { c, ts } — the bonus lives in Convex, never in Redis (F6 contract).
--
-- KEYS[1] = canvas pixels key   (string, 1 byte/pixel, row-major)
-- KEYS[2] = user gauge key       (hash: { c = charges, ts = refill clock ms })
-- KEYS[3] = meta / version key   (monotonic per-canvas write sequence; fan-out + resync)
-- KEYS[4] = frozen flag key       (optional; emergency freeze, F8.4. "1" = placement
--                                  closed for everyone. Absent/falsey = open. Checked
--                                  before any gauge work so a freeze is instantaneous.)
-- KEYS[5] = durable stream key    (optional; per-canvas placement stream, R2. Each
--                                  accepted write is XADDed here as a full
--                                  {x,y,color,version,userId,ts} record for the worker
--                                  to drain to Convex. Omit it and no stream is written
--                                  — e.g. unit harnesses passing only pixels+gauge.)
-- KEYS[6] = ban set key            (optional; per-canvas SET of banned userIds, F4 CA6.
--                                  SISMEMBER'd before the gauge so a banned viewer is
--                                  rejected ("banned") atomically on the next write.
--                                  Absent/"" = ban enforcement off. Populated by the
--                                  moderation ban-push (FEN-19); durable source = Convex.)
-- KEYS[7] = op idempotency key     (optional; per-(canvas,user,op) claim key, F4 CA5.
--                                  Claimed with SET NX the instant before a placement
--                                  commits; a replay of the same client op returns the
--                                  prior ok WITHOUT a second consume/fan-out. Absent/""
--                                  = idempotency off, e.g. a client that sends no opId.)
--
-- ARGV[1]  = x
-- ARGV[2]  = y
-- ARGV[3]  = width
-- ARGV[4]  = height
-- ARGV[5]  = color (palette index; 0 = eraser, still costs 1)
-- ARGV[6]  = paletteSize
-- ARGV[7]  = nowMs               (also the ts stamped onto the stream record)
-- ARGV[8]  = refillIntervalMs
-- ARGV[9]  = refillAmount
-- ARGV[10] = gaugeMax            (effective max = base + bonus, computed by the gateway)
-- ARGV[11] = gaugeTtlMs          (TTL on the gauge hash; 0 = never expire)
-- ARGV[12] = deltaChannel        (pub/sub channel for fan-out; "" disables publish)
-- ARGV[13] = userId              (authenticated placer; stamped onto the stream record.
--                                  May be "" — defensive only; anonymous never places.)
-- ARGV[14] = opId                (client op id for idempotency, F4 CA5; "" disables it.
--                                  Matches the KEYS[7] claim key the gateway built.)
-- ARGV[15] = opTtlMs             (TTL on the op claim key; 0 = never expire. Only the
--                                  client retry window needs covering.)
-- ARGV[16] = streamMaxLen        (optional; approximate MAXLEN backstop on the durable
--                                  stream XADD, FEN-651/A8. 0 / absent = no cap. Caps
--                                  Redis memory if the worker is DOWN and the post-flush
--                                  MINID trim stops running. See docs/contracts/retention.md.)
--
-- Returns: { status, charges, max, cooldownUntil }
--   status        = "ok" | "cooldown" | "out_of_bounds" | "invalid_color" | "frozen" | "banned"
--   charges       = charges remaining after the call
--   max           = effective max in force this call
--   cooldownUntil = epoch ms the next charge lands (0 = gauge full). On a
--                   rejected placement this is when the viewer may place again.

local x          = tonumber(ARGV[1])
local y          = tonumber(ARGV[2])
local width      = tonumber(ARGV[3])
local height     = tonumber(ARGV[4])
local color      = tonumber(ARGV[5])
local paletteSize= tonumber(ARGV[6])
local now        = tonumber(ARGV[7])
local interval   = tonumber(ARGV[8])
local amount     = tonumber(ARGV[9])
local max        = tonumber(ARGV[10])
local gaugeTtl   = tonumber(ARGV[11])
local deltaChan  = ARGV[12]
local placerId   = ARGV[13] or ""
local opId       = ARGV[14] or ""
local opTtl      = tonumber(ARGV[15]) or 0
local streamMaxLen = tonumber(ARGV[16]) or 0

-- Emergency freeze (F8.4): a moderator can close the canvas for everyone in one
-- write (SET frozen flag). Checked before bounds/gauge so it takes effect on the
-- very next placement — no charge is touched, no fan-out is emitted. KEYS[4] is
-- optional so unit harnesses that pass only bitmap+gauge[+counter] keep working.
if KEYS[4] and redis.call("GET", KEYS[4]) == "1" then
  return { "frozen", 0, max, 0 }
end

-- Ban enforcement (F4 CA6): a banned viewer cannot place. Checked right after the
-- global freeze and before bounds/gauge, so a ban that lands mid-session blocks
-- the very next placement across every gateway instance — no charge touched, no
-- fan-out. KEYS[6] optional ("" or absent = off); placerId "" (anonymous, which
-- never reaches here anyway) is never a member.
if KEYS[6] and KEYS[6] ~= "" and placerId ~= ""
   and redis.call("SISMEMBER", KEYS[6], placerId) == 1 then
  return { "banned", 0, max, 0 }
end

-- Defensive validation (the gateway also validates before calling).
if x < 0 or y < 0 or x >= width or y >= height then
  return { "out_of_bounds", 0, 0, 0 }
end
if color < 0 or color >= paletteSize then
  return { "invalid_color", 0, 0, 0 }
end

-- Load + lazy-refill the gauge (mirror of gauge.ts refillGauge).
local charges = tonumber(redis.call("HGET", KEYS[2], "c"))
local ts      = tonumber(redis.call("HGET", KEYS[2], "ts"))
if charges == nil then
  -- First placement on this canvas → arrive full.
  charges = max
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
local ticks = math.floor(elapsed / interval)
if ticks > 0 then
  charges = math.min(max, charges + ticks * amount)
  ts = ts + ticks * interval
end
if charges >= max then
  charges = max
  ts = now
end

-- Not enough charge → reject, report when the next charge lands.
if charges < 1 then
  return { "cooldown", 0, max, ts + interval }
end

-- Idempotency claim (F4 CA5). We are now committed to placing (validated, in
-- bounds, has charge), so claim the op key with SET NX *before* the write. The
-- claim and the write are in the same atomic script, so a replay of the same
-- client op (e.g. an optimistic client resending an un-acked placement after a
-- reconnect, possibly onto another gateway instance) can never double-consume or
-- double-fan-out: the second call finds the key set and returns the prior ok
-- without consuming a charge or publishing again. We claim only here — never on a
-- cooldown/ban/oob reject — so retrying a rejected op later still gets to place.
-- The returned gauge on a replay is the live (un-consumed) state; the exact
-- post-original numbers aren't reconstructed, which a duplicate ack tolerates.
if opId ~= "" and KEYS[7] and KEYS[7] ~= "" then
  local claimed
  if opTtl > 0 then
    claimed = redis.call("SET", KEYS[7], "1", "NX", "PX", opTtl)
  else
    claimed = redis.call("SET", KEYS[7], "1", "NX")
  end
  if not claimed then
    local cd = 0
    if charges < max then cd = ts + interval end
    return { "ok", charges, max, cd }
  end
end

-- Atomic write: single byte at the row-major offset.
local offset = y * width + x
redis.call("SETRANGE", KEYS[1], offset, string.char(color))

-- Assign a per-canvas, monotonic version to this write, persist it durably, and
-- fan it out. All inside the same atomic script as the SETRANGE, so version
-- order == write order across every gateway instance — which is what lets a
-- reconnecting client replay exactly what it missed (resync, F7/FEN-13) and lets
-- the worker drain an exactly-ordered placement log (R2). The version also
-- labels the snapshot a fresh client reads.
--
-- Two sinks, decided independently of each other (FEN-54):
--   * KEYS[5] stream — the DURABILITY path. XADD the full record the worker
--     drains to Convex. Written whenever a stream key is supplied, regardless of
--     whether fan-out is enabled.
--   * deltaChan pub/sub — the REALTIME path. The ephemeral "version,x,y,color"
--     payload the gateway coalesces to clients; unchanged by FEN-54.
--
-- Guarded on KEYS[3] so callers that don't care about versioning (e.g. unit
-- harnesses passing only the pixels + gauge keys) still work.
if KEYS[3] then
  local version = redis.call("INCR", KEYS[3])
  if KEYS[5] then
    -- Durability sink (R2). An approximate MAXLEN backstop (FEN-651/A8) caps Redis
    -- memory if the worker is DOWN and the post-flush MINID trim (worker drain) stops
    -- running — otherwise the stream grows unbounded under the firehose. `~` keeps the
    -- trim amortised-O(1) on the hot path. streamMaxLen <= 0 disables the cap (unit
    -- harnesses / callers that pass no limit). Canvas STATE is never at risk (it lives
    -- in KEYS[1] + periodic snapshots); only undrained placement HISTORY beyond the cap
    -- can be lost — see docs/contracts/retention.md for the trade-off and sizing.
    if streamMaxLen > 0 then
      redis.call("XADD", KEYS[5], "MAXLEN", "~", streamMaxLen, "*",
        "x", x, "y", y, "color", color,
        "version", version, "userId", placerId, "ts", now)
    else
      redis.call("XADD", KEYS[5], "*",
        "x", x, "y", y, "color", color,
        "version", version, "userId", placerId, "ts", now)
    end
  end
  if deltaChan ~= "" then
    redis.call("PUBLISH", deltaChan, version .. "," .. x .. "," .. y .. "," .. color)
  end
end

-- Consume one charge and persist.
charges = charges - 1
redis.call("HSET", KEYS[2], "c", charges, "ts", ts)
if gaugeTtl > 0 then
  redis.call("PEXPIRE", KEYS[2], gaugeTtl)
end

-- After a consume charges < max, so the next tick is always pending.
return { "ok", charges, max, ts + interval }
