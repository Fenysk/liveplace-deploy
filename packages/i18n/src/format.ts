/** Values that can be interpolated into a message placeholder. */
export type MessageParams = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replace `{name}` placeholders in `template` with values from `params`.
 *
 * Missing params are left as the literal `{name}` token rather than throwing —
 * a visible-but-harmless artefact is better than a runtime crash in the live
 * UI. Interpolation is intentionally minimal (no plural/gender rules); FR/EN
 * MVP strings do not need ICU.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}
