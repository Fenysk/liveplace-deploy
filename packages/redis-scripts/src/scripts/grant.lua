-- grant.lua — atomically grant N charges to a user's gauge (tier claim, FEN-130).
--
-- The board-locked "claim de palier" (Lot D) raises a viewer's permanent gauge
-- max by 1 per encashed tier AND, by board default, hands them +1 immediately
-- usable charge so the celebration is actionable mid-cooldown (docs/contracts/
-- tier-claim.md). The +max bonus lives in Convex (the gateway folds it into the
-- effective `gaugeMax` it passes here); this script does the *charge* half: it
-- refills the gauge to `now` with the same lazy arithmetic as place.lua /
-- refill-peek.lua, adds `grant` charges, clamps to the (already-raised) effective
-- max, and persists. Atomic (single Redis-threaded EVAL) so the refill→add→clamp
-- →write cannot interleave with a concurrent place.lua consume.
--
-- Mirrors ../gauge.ts refillGauge for the refill; the add+clamp is the only extra
-- step. Granting 0 is a pure refill-and-persist (a harmless no-op on charges).
--
-- KEYS[1] = user gauge key       (hash: { c = charges, ts = refill clock ms })
--
-- ARGV[1] = nowMs
-- ARGV[2] = refillIntervalMs
-- ARGV[3] = refillAmount
-- ARGV[4] = gaugeMax             (EFFECTIVE max = base + the just-raised bonus)
-- ARGV[5] = grant                (charges to add, >= 0)
-- ARGV[6] = gaugeTtlMs           (TTL on the gauge hash; 0 = never expire)
--
-- Returns: { charges, max, cooldownUntil }
--   charges       = charges after refill + grant, clamped to max
--   max           = effective max
--   cooldownUntil = epoch ms the next charge lands (0 = gauge full)

local now      = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local amount   = tonumber(ARGV[3])
local max      = tonumber(ARGV[4])
local grant    = tonumber(ARGV[5])
local gaugeTtl  = tonumber(ARGV[6])

if grant == nil or grant < 0 then grant = 0 end

local charges = tonumber(redis.call("HGET", KEYS[1], "c"))
local ts      = tonumber(redis.call("HGET", KEYS[1], "ts"))
if charges == nil then
  -- Never placed → conceptually full at the (raised) max. A grant on top is
  -- clamped away, but we must now materialise the hash so the higher ceiling and
  -- the granted charge survive: write a full gauge at `now`.
  charges = max
  ts = now
else
  local elapsed = now - ts
  if elapsed < 0 then elapsed = 0 end
  local ticks = math.floor(elapsed / interval)
  if ticks > 0 then
    charges = math.min(max, charges + ticks * amount)
    ts = ts + ticks * interval
  end
end

-- Add the granted charges, clamped to the effective max (never exceed, D1 CA2).
charges = math.min(max, charges + grant)

-- Full → regeneration is paused; pin the clock to now (same rule as the refill).
if charges >= max then
  charges = max
  ts = now
end

redis.call("HSET", KEYS[1], "c", charges, "ts", ts)
if gaugeTtl > 0 then
  redis.call("PEXPIRE", KEYS[1], gaugeTtl)
end

local cooldownUntil = 0
if charges < max then
  cooldownUntil = ts + interval
end

return { charges, max, cooldownUntil }
