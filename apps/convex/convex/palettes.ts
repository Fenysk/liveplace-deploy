/**
 * Palette management (F2). The system default palette is shared by every owner
 * who does not supply a custom one; custom palettes belong to their owner.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/identity";
import {
  DEFAULT_PALETTE_COLORS,
  assertPaletteEditable,
  assertValidPalette,
  type PaletteColor,
} from "./lib/canvasRules";

const colorValidator = v.array(v.object({ index: v.number(), hex: v.string() }));

/**
 * Idempotently ensure the system default palette exists and return its id.
 * Used by `createCanvas` when the caller does not specify a palette, and by the
 * seed script. Safe to call repeatedly: it returns the existing row if present.
 */
export const ensureDefaultPalette = mutation({
  args: {},
  returns: v.id("palettes"),
  handler: async (ctx): Promise<Id<"palettes">> => {
    const existing = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", null))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("palettes", {
      ownerId: null,
      version: 1,
      colors: DEFAULT_PALETTE_COLORS.map((c) => ({ index: c.index, hex: c.hex })),
    });
  },
});

/** Create a custom palette owned by the caller. */
export const createPalette = mutation({
  args: { colors: colorValidator },
  returns: v.id("palettes"),
  handler: async (ctx, args): Promise<Id<"palettes">> => {
    const ownerId = await requireUserId(ctx);
    assertValidPalette(args.colors as PaletteColor[]);
    return await ctx.db.insert("palettes", {
      ownerId,
      version: 1,
      colors: args.colors,
    });
  },
});

/** Replace a custom palette's colours, bumping its version (cache invalidation). */
export const updatePalette = mutation({
  args: { paletteId: v.id("palettes"), colors: colorValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireUserId(ctx);
    const palette = await ctx.db.get(args.paletteId);
    if (!palette) throw new Error("palette not found");
    assertPaletteEditable(palette, ownerId);
    assertValidPalette(args.colors as PaletteColor[]);
    await ctx.db.patch(args.paletteId, {
      colors: args.colors,
      version: palette.version + 1,
    });
    return null;
  },
});

/** List the palettes available to the caller: the system default + their own. */
export const listAvailablePalettes = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const system = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", null))
      .collect();
    const mine = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    return [...system, ...mine];
  },
});
