-- grid-resize.lua — atomic row-wise relayout of the canvas pixel buffer.
--
-- When a canvas is resized (shrink or enlarge), the Redis bitmap stride changes:
-- old[y*oldW+x] must become new[y*newW+x].  Without this relayout the existing
-- bytes are misread at the wrong stride, producing scrambled pixels on the live
-- canvas (R1 latent bug — only invisible post-migration because the grid is empty).
--
-- The entire GET + rewrite + SET runs in a single atomic Lua script, so no
-- concurrent placement can land on the old stride between the read and the write
-- (R2 atomicity). The script returns the count of non-zero pixels that survived
-- inside the new bounds, so the caller can log or report it.
--
-- Crop (shrink): columns x >= newW and rows y >= newH are discarded.
-- Enlarge: new columns (x >= oldW) and new rows (y >= oldH) are zero-filled.
--
-- KEYS[1] = canvas pixels key (string, 1 byte/pixel, row-major)
--
-- ARGV[1] = oldWidth
-- ARGV[2] = oldHeight
-- ARGV[3] = newWidth
-- ARGV[4] = newHeight
--
-- Returns: number of surviving non-zero pixels kept in the new buffer.

local oldW = tonumber(ARGV[1])
local oldH = tonumber(ARGV[2])
local newW = tonumber(ARGV[3])
local newH = tonumber(ARGV[4])

-- GET returns `false` when the key does not exist (Lua nil would be wrong here).
local old = redis.call("GET", KEYS[1])
if not old then old = "" end

local minW = math.min(oldW, newW)
local minH = math.min(oldH, newH)
local zero  = string.char(0)
local surviving = 0
local rows = {}

for y = 0, newH - 1 do
  if y < minH then
    -- Overlapping row: copy the first minW pixels from the old row.
    local startOff = y * oldW + 1    -- Lua strings are 1-indexed
    local endOff   = startOff + minW - 1
    local slice = string.sub(old, startOff, endOff)
    -- Defensive: old buffer may be shorter than oldW*oldH (e.g. blank canvas).
    if #slice < minW then
      slice = slice .. string.rep(zero, minW - #slice)
    end
    -- Count non-zero pixels that survive into the new bounds.
    for i = 1, #slice do
      if string.byte(slice, i) ~= 0 then
        surviving = surviving + 1
      end
    end
    -- Pad new columns with zeros when enlarging horizontally.
    if newW > minW then
      rows[y + 1] = slice .. string.rep(zero, newW - minW)
    else
      rows[y + 1] = slice
    end
  else
    -- New rows beyond old height: zero-fill.
    rows[y + 1] = string.rep(zero, newW)
  end
end

-- table.concat is O(n) — much better than repeated .. on the hot buffer.
redis.call("SET", KEYS[1], table.concat(rows))

return surviving
