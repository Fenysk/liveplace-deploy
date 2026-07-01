import type { Locale } from "../locale.js";
import { en, type Catalog } from "./en.js";
import { fr } from "./fr.js";

export type { Catalog, MessageKey } from "./en.js";
export { en } from "./en.js";
export { fr } from "./fr.js";

/** All shipped catalogs, indexed by locale. */
export const CATALOGS: Record<Locale, Catalog> = { en, fr };
