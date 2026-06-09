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
 * referenced by name (decoupled convention). Strings via `t(...)` (FR↔EN). The
 * look is the Arcade design system (FEN-268): shared Field / Button / Toast,
 * tokens only — no hard-coded value or local component (FEN-271, Lot C / AC1, AC6).
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { authClient } from "../../auth/auth-client";
import { Link, navigate } from "../../router.js";
import { paths } from "../../routes.js";
import { Button, Field, Toast } from "../../ui/index.js";
import {
  DEFAULT_SIZE_KEY,
  SIZE_PRESETS,
  buildCreateArgs,
  createErrorKey,
  validateCanvasName,
  type SizeKey,
} from "./studioView.js";
import "./studio.css";

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

  // Custom (owned) palettes only; the system default is the implicit "" option.
  const customPalettes = (palettes ?? []).filter((p) => p.ownerId !== null);

  if (!isPending && !isSignedIn) {
    return (
      <section className="lp-studio lp-studio--narrow">
        <h1 className="lp-studio__title">{t("studio.create.title")}</h1>
        <p className="lp-studio__muted">{t("studio.signInPrompt")}</p>
        <Link to={paths.studio()} className="lp-studio__link">
          {t("studio.create.back")}
        </Link>
      </section>
    );
  }

  return (
    <CreateCanvasForm
      customPalettes={customPalettes}
      onCreate={async (args) => {
        await create(args as Record<string, unknown>);
        // Land on the dashboard: the new canvas is now the active one, with
        // "Diffuser" (WF-7) one click away — flow S1 → S2.
        navigate(paths.studio());
      }}
    />
  );
}

/**
 * Presentation + form logic only (no Convex/auth) so it can be rendered on the
 * QA states board (FEN-276) with a no-op `onCreate`. `customPalettes` is the
 * already-filtered option list; `onCreate` performs the side effect and may
 * throw — the form maps the failure to the inline error Toast. `initialName`
 * seeds the field (used by the board to show the "name too long" error state).
 */
export function CreateCanvasForm({
  customPalettes,
  onCreate,
  initialName = "",
}: {
  customPalettes: PaletteDoc[];
  onCreate: (args: ReturnType<typeof buildCreateArgs>) => Promise<void>;
  initialName?: string;
}): React.ReactElement {
  const t = useTranslate();

  const [name, setName] = useState(initialName);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // `undefined` = "not touched" → omitted so the backend default applies (S1).
  const [sizeKey, setSizeKey] = useState<SizeKey | undefined>(undefined);
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ReturnType<typeof createErrorKey> | null>(null);

  const nameCheck = validateCanvasName(name);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!nameCheck.ok || submitting) return;
    setSubmitting(true);
    setErrorKey(null);
    try {
      const args = buildCreateArgs({ name, sizeKey, paletteId, isPublic });
      await onCreate(args);
    } catch (error) {
      setErrorKey(createErrorKey(error));
      setSubmitting(false);
    }
  }

  return (
    <section className="lp-studio lp-studio--narrow" aria-label={t("studio.create.title")}>
      <h1 className="lp-studio__title">{t("studio.create.title")}</h1>

      <form className="lp-studio__form" onSubmit={handleSubmit}>
        {/* Minimal path: name → Create. The Field owns label + hint/error wiring
            (aria-describedby / aria-invalid), so the over-long name is announced. */}
        <Field
          id="canvas-name"
          label={t("studio.create.nameLabel")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("studio.create.namePlaceholder")}
          maxLength={200}
          hint={t("studio.create.nameHint")}
          error={nameCheck.ok ? null : t("studio.create.nameTooLong")}
        />

        {/* Advanced options, folded by default (defaults pre-filled). */}
        <details
          className="lp-studio__details"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="lp-studio__summary">{t("studio.create.advanced")}</summary>

          <fieldset className="lp-studio__fieldset">
            <legend className="lp-studio__legend">{t("studio.create.sizeLabel")}</legend>
            {SIZE_PRESETS.map((preset) => (
              <label key={preset.key} className="lp-studio__choice">
                <input
                  type="radio"
                  name="size"
                  value={preset.key}
                  // Show the effective default (Medium) pre-selected so the
                  // streamer sees the size they'll get, while an untouched
                  // sizeKey stays undefined → omitted from the args (S2 /
                  // FEN-143). Picking any radio sets sizeKey and takes over.
                  checked={(sizeKey ?? DEFAULT_SIZE_KEY) === preset.key}
                  onChange={() => setSizeKey(preset.key)}
                />
                <span>
                  <strong>{t(preset.labelKey)}</strong>
                  <span className="lp-studio__consequence"> — {t(preset.hintKey)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="lp-studio__field-row">
            <label htmlFor="palette" className="lp-studio__field-label">
              {t("studio.create.paletteLabel")}
            </label>
            <select
              id="palette"
              className="lp-studio__select"
              value={paletteId ?? ""}
              onChange={(e) => setPaletteId(e.target.value || null)}
            >
              <option value="">{t("studio.create.paletteDefault")}</option>
              {customPalettes.map((p, i) => (
                <option key={p._id} value={p._id}>
                  {`#${i + 1}`}
                </option>
              ))}
            </select>
          </div>

          <label className="lp-studio__choice">
            <input
              type="checkbox"
              checked={isPublic ?? false}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span>
              <strong>{t("studio.create.publicLabel")}</strong>
              <span className="lp-studio__consequence"> — {t("studio.create.publicHint")}</span>
            </span>
          </label>
        </details>

        {errorKey && <Toast kind="error" title={t(errorKey)} />}

        <div className="lp-studio__form-actions">
          <Button type="submit" loading={submitting} disabled={!nameCheck.ok}>
            {submitting ? t("studio.create.creating") : t("studio.create.submit")}
          </Button>
          <Link to={paths.studio()} className="lp-studio__link">
            {t("studio.create.back")}
          </Link>
        </div>
      </form>
    </section>
  );
}
