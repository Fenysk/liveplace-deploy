-- place-pixel.lua — atomic pixel placement with charge-based cooldown gauge.
--
-- This is the entire hot-path write, executed atomically by Redis (single
-- threaded). It is the mitigation for R1 (concurrency / cooldown bypass):
-- the refill → check → write → decrement sequence cannot interleave with
-- another client's, so there are no lost updates and the cooldown cannot be
-- raced around.
--
-- The "gauge" (jauge) is a charge bucket: a user holds up to MAX_CHARGES
-- pixels, regenerating one every REGEN_MS. Placing consumes one charge.
-- This subsumes a simple fixed cooldown (MAX_CHARGES = 1). Defaults for
-- REGEN_MS / MAX_CHARGES are decision D1 (Product Owner) and are passed in
-- by the gateway, not hard-coded here.
--
-- KEYS[1] = canvas bitmap key      (string, 1 byte/pixel, row-major)
-- KEYS[2] = user gauge key         (hash: { c = charges, ts = clock epoch ms })
--
-- ARGV[1] = x
-- ARGV[2] = y
-- ARGV[3] = width
-- ARGV[4] = height
-- ARGV[5] = color (palette index)
-- ARGV[6] = paletteSize
-- ARGV[7] = nowMs
-- ARGV[8] = regenMs       (charge regeneration interval)
-- ARGV[9] = maxCharges
-- ARGV[10] = gaugeTtlMs   (TTL applied to the gauge hash to reclaim idle users)
-- ARGV[11] = deltaChannel (pub/sub channel for fan-out; "" disables publish)
--
-- Returns: { status, charges, cooldownUntil }
--   status       = "ok" | "cooldown" | "out_of_bounds" | "invalid_color"
--   charges      = charges remaining after the call
--   cooldownUntil = epoch ms the user may place again (0 = has charges now)

local x          = tonumber(ARGV[1])
local y          = tonumber(ARGV[2])
local width      = tonumber(ARGV[3])
local height     = tonumber(ARGV[4])
local color      = tonumber(ARGV[5])
local paletteSize= tonumber(ARGV[6])
local now        = tonumber(ARGV[7])
local regen      = tonumber(ARGV[8])
local maxCharges = tonumber(ARGV[9])
local gaugeTtl   = tonumber(ARGV[10])
local deltaChan  = ARGV[11]

-- Defensive validation (the gateway also validates before calling).
if x < 0 or y < 0 or x >= width or y >= height then
  return { "out_of_bounds", 0, 0 }
end
if color < 0 or color >= paletteSize then
  return { "invalid_color", 0, 0 }
end

-- Load and refill the gauge.
local charges = tonumber(redis.call("HGET", KEYS[2], "c"))
local ts      = tonumber(redis.call("HGET", KEYS[2], "ts"))
if charges == nil then
  charges = maxCharges
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
local gained = math.floor(elapsed / regen)
if gained > 0 then
  charges = math.min(maxCharges, charges + gained)
  ts = ts + gained * regen
end
-- If full, the regen clock has no meaning until the next consume.
if charges >= maxCharges then
  charges = maxCharges
  ts = now
end

-- Not enough charge → reject, report when the next charge lands.
if charges < 1 then
  local cooldownUntil = ts + regen
  return { "cooldown", 0, cooldownUntil }
end

-- We are about to consume a charge. If we were at full, start the regen clock now.
if charges >= maxCharges then
  ts = now
end

-- Atomic write: single byte at row-major offset.
local offset = y * width + x
redis.call("SETRANGE", KEYS[1], offset, string.char(color))

-- Fan-out for the realtime stream (R2): every gateway instance subscribed to
-- the channel receives this write and coalesces it into its next frame.
if deltaChan ~= "" then
  redis.call("PUBLISH", deltaChan, x .. "," .. y .. "," .. color)
end

charges = charges - 1
redis.call("HSET", KEYS[2], "c", charges, "ts", ts)
if gaugeTtl > 0 then
  redis.call("PEXPIRE", KEYS[2], gaugeTtl)
end

local cooldownUntil = 0
if charges < 1 then
  cooldownUntil = ts + regen
end

return { "ok", charges, cooldownUntil }
