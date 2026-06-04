/**
 * Create a canvas — minimal path + repliable advanced options (FEN-120 / WF-6,
 * flow S1). The whole screen IS the streamer onboarding (D9): a NAME and "Create"
 * is enough to start (the name may even be blank — the backend derives a default
 * title), and everything else is folded away behind "Options" with its
 * consequence explained inline (F9 "grande grille = plus de monde, moins
 * lisible"). On success it lands on the dashboard, where the new canvas is the
 * active one and "Diffuser" (OBS, WF-7) is one click away (flow S1 → S2).
 *
 * All form logic — name validation, default-omitting arg building, server-error
 * mapping — lives in the pure `studioView.ts` (unit-tested). `createCanvas` is
 * referenced by name (decoupled convention). Strings via `t(...)` (FR↔EN).
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client";
import { Link, navigate } from "../../router.js";
import { paths } from "../../routes.js";
import {
  SIZE_PRESETS,
  buildCreateArgs,
  createErrorKey,
  validateCanvasName,
  type CreateCanvasArgs,
  type SizeKey,
} from "./studioView.js";

// Args typed as a plain record (Convex's `DefaultFunctionArgs` needs an index
// signature, which our all-optional `CreateCanvasArgs` interface lacks); the
// strongly-typed object is built by `buildCreateArgs` and assigned in.
const createCanvas = makeFunctionReference<"mutation", Record<string, unknown>, string>(
  "canvases:createCanvas",
);

interface PaletteDoc {
  _id: string;
  ownerId: string | null;
}
const listAvailablePalettes = makeFunctionReference<
  "query",
  Record<string, never>,
  PaletteDoc[]
>("palettes:listAvailablePalettes");

export function CreateCanvasPage(): React.ReactElement {
  const t = useTranslate();
  const { data: session, isPending } = authClient.useSession();
  const isSignedIn = !!session;

  const create = useMutation(createCanvas);
  const palettes = useQuery(listAvailablePalettes, isSignedIn ? {} : "skip");

  const [name, setName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // `undefined` = "not touched" → omitted so the backend default applies (S1).
  const [sizeKey, setSizeKey] = useState<SizeKey | undefined>(undefined);
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ReturnType<typeof createErrorKey> | null>(null);

  const nameCheck = validateCanvasName(name);
  // Custom (owned) palettes only; the system default is the implicit "" option.
  const customPalettes = (palettes ?? []).filter((p) => p.ownerId !== null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!nameCheck.ok || submitting) return;
    setSubmitting(true);
    setErrorKey(null);
    try {
      const args = buildCreateArgs({ name, sizeKey, paletteId, isPublic });
      // Cast to the loosened arg shape: the object is built strongly-typed above.
      await create(args as Record<string, unknown>);
      // Land on the dashboard: the new canvas is now the active one, with
      // "Diffuser" (WF-7) one click away — flow S1 → S2.
      navigate(paths.studio());
    } catch (error) {
      setErrorKey(createErrorKey(error));
      setSubmitting(false);
    }
  }

  if (!isPending && !isSignedIn) {
    return (
      <section style={pageStyle}>
        <h1 style={titleStyle}>{t("studio.create.title")}</h1>
        <p style={mutedStyle}>{t("studio.signInPrompt")}</p>
        <Link to={paths.studio()} style={linkStyle}>
          {t("studio.create.back")}
        </Link>
      </section>
    );
  }

  return (
    <section style={pageStyle} aria-label={t("studio.create.title")}>
      <h1 style={titleStyle}>{t("studio.create.title")}</h1>

      <form onSubmit={handleSubmit}>
        {/* Minimal path: name → Create. */}
        <label htmlFor="canvas-name" style={labelStyle}>
          {t("studio.create.nameLabel")}
        </label>
        <input
          id="canvas-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("studio.create.namePlaceholder")}
          maxLength={200}
          aria-invalid={!nameCheck.ok}
          aria-describedby="canvas-name-hint"
          style={inputStyle}
        />
        <p id="canvas-name-hint" style={hintStyle}>
          {nameCheck.ok ? t("studio.create.nameHint") : t("studio.create.nameTooLong")}
        </p>

        {/* Advanced options, folded by default (defaults pre-filled). */}
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          style={detailsStyle}
        >
          <summary style={summaryStyle}>{t("studio.create.advanced")}</summary>

          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>{t("studio.create.sizeLabel")}</legend>
            {SIZE_PRESETS.map((preset) => (
              <label key={preset.key} style={radioRowStyle}>
                <input
                  type="radio"
                  name="size"
                  value={preset.key}
                  checked={sizeKey === preset.key}
                  onChange={() => setSizeKey(preset.key)}
                />
                <span>
                  <strong>{t(preset.labelKey)}</strong>
                  <span style={consequenceStyle}> — {t(preset.hintKey)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div style={fieldRowStyle}>
            <label htmlFor="palette" style={labelStyle}>
              {t("studio.create.paletteLabel")}
            </label>
            <select
              id="palette"
              value={paletteId ?? ""}
              onChange={(e) => setPaletteId(e.target.value || null)}
              style={selectStyle}
            >
              <option value="">{t("studio.create.paletteDefault")}</option>
              {customPalettes.map((p, i) => (
                <option key={p._id} value={p._id}>
                  {`#${i + 1}`}
                </option>
              ))}
            </select>
          </div>

          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={isPublic ?? false}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span>
              <strong>{t("studio.create.publicLabel")}</strong>
              <span style={consequenceStyle}> — {t("studio.create.publicHint")}</span>
            </span>
          </label>
        </details>

        {errorKey && (
          <p role="alert" style={errorStyle}>
            {t(errorKey)}
          </p>
        )}

        <div style={actionRowStyle}>
          <button type="submit" disabled={!nameCheck.ok || submitting} style={primaryBtnStyle}>
            {submitting ? t("studio.create.creating") : t("studio.create.submit")}
          </button>
          <Link to={paths.studio()} style={linkStyle}>
            {t("studio.create.back")}
          </Link>
        </div>
      </form>
    </section>
  );
}

// --- Inline styles (delegated visual pass) -----------------------------------
const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 560,
  margin: "2.5rem auto",
  padding: "0 1rem",
};
const titleStyle: React.CSSProperties = { margin: "0 0 1.5rem" };
const mutedStyle: React.CSSProperties = { color: "#777" };
const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, marginBottom: "0.35rem" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.6rem 0.75rem",
  fontSize: 16,
  borderRadius: 8,
  border: "1px solid #c7c7d1",
};
const hintStyle: React.CSSProperties = { color: "#888", fontSize: 13, margin: "0.4rem 0 1.25rem" };
const detailsStyle: React.CSSProperties = {
  border: "1px solid #ececf1",
  borderRadius: 10,
  padding: "0.5rem 0.85rem",
  marginBottom: "1.25rem",
};
const summaryStyle: React.CSSProperties = { cursor: "pointer", fontWeight: 600, padding: "0.35rem 0" };
const fieldsetStyle: React.CSSProperties = {
  border: "none",
  margin: "0.5rem 0 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const legendStyle: React.CSSProperties = { fontWeight: 600, padding: 0, marginBottom: "0.35rem" };
const radioRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  fontSize: 14,
  lineHeight: 1.35,
};
const consequenceStyle: React.CSSProperties = { color: "#888" };
const fieldRowStyle: React.CSSProperties = { margin: "1rem 0 0" };
const selectStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  fontSize: 15,
  borderRadius: 8,
  border: "1px solid #c7c7d1",
};
const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  fontSize: 14,
  lineHeight: 1.35,
  margin: "1rem 0 0",
};
const errorStyle: React.CSSProperties = {
  color: "#b00020",
  background: "#fdecef",
  border: "1px solid #f5c2cc",
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  margin: "0 0 1rem",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.6rem 1.4rem",
  borderRadius: 8,
  border: "1px solid #6441a5",
  background: "#6441a5",
  color: "#fff",
  fontWeight: 600,
  fontSize: 15,
  cursor: "pointer",
};
const linkStyle: React.CSSProperties = { color: "#6441a5", textDecoration: "none" };
