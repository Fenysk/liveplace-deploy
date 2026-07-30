-- refill-peek.lua — read-only gauge snapshot for display (current / max / countdown).
--
-- Computes the *current* gauge state with the same lazy refill as place.lua, but
-- WITHOUT consuming a charge, writing the canvas, or persisting. Used to render
-- the viewer's gauge (current/max) and the countdown to the next charge in the
-- web UI and the OBS overlay. Decision D1; mirrors ../gauge.ts refillGauge.
--
-- It does not persist the refilled state: the refill is a pure function of the
-- stored (charges, ts) and `now`, so place.lua and a later peek always agree.
-- Keeping peek side-effect free means the OBS overlay can poll it freely.
--
-- `gaugeMax` is the *effective* max (base + bonus) the gateway computes per
-- session — same value passed to place.lua, so the displayed ceiling matches.
--
-- KEYS[1] = user gauge key  (hash: { c = charges, ts = refill clock ms })
--
-- ARGV[1] = nowMs
-- ARGV[2] = refillIntervalMs
-- ARGV[3] = refillAmount
-- ARGV[4] = gaugeMax        (effective max = base + bonus)
--
-- Returns: { charges, max, cooldownUntil }
--   charges       = current charges after a virtual refill
--   max           = effective max
--   cooldownUntil = epoch ms the next charge lands (0 = gauge full)

local now      = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local amount   = tonumber(ARGV[3])
local max      = tonumber(ARGV[4])

local charges = tonumber(redis.call("HGET", KEYS[1], "c"))
local ts      = tonumber(redis.call("HGET", KEYS[1], "ts"))
if charges == nil then
  -- Never placed → the viewer is conceptually full (first pose starts at max).
  return { max, max, 0 }
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

local cooldownUntil = 0
if charges < max then
  cooldownUntil = ts + interval
end

return { charges, max, cooldownUntil }
