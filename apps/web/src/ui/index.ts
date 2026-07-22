/**
 * Arcade design-system barrel (FEN-268, Lot 0).
 *
 * The shared layer every screen lot imports from: one definition per component,
 * token-only styling, all states/variants. Importing this module also pulls in
 * the global stylesheet (tokens + Tailwind @theme + component classes + fonts).
 *
 * Usage:  import { Button, StatusPill } from "../../ui/index.js";
 */
import "./styles/index.css";

export { Button, type ButtonProps } from "./Button.js";
export { Field, type FieldProps } from "./Field.js";
export { Toast, type ToastProps } from "./Toast.js";
export { StatusPill, type StatusPillProps } from "./StatusPill.js";
export { Gauge, type GaugeProps } from "./Gauge.js";
export { Celebration, type CelebrationProps } from "./Celebration.js";
export {
  ColorSelector,
  type ColorSelectorProps,
  type EraserItem,
  type PaletteColor,
} from "./ColorSelector.js";
export { Wordmark, type WordmarkProps } from "./Wordmark.js";
export { HeroGauge, type HeroGaugeProps } from "./HeroGauge.js";
export { TwitchGlyph, type TwitchGlyphProps } from "./TwitchGlyph.js";
export {
  Surface,
  Card,
  Stack,
  Row,
  Skeleton,
  EmptyState,
} from "./primitives.js";
export { StateScreen, type StateScreenProps, type StateScreenAction } from "./StateScreen.js";
export { StateArt } from "./StateArt.js";
export { OfflineBanner, type OfflineBannerProps } from "./OfflineBanner.js";
export {
  BottomSheet,
  type BottomSheetProps,
  type SheetPresentation,
  resolveShowHandle,
  resolveDragDismiss,
  shouldDismissOnDrag,
} from "./BottomSheet.js";
export { PanelHandle, type PanelHandleProps } from "./PanelHandle.js";
export { Switch, type SwitchProps } from "./Switch.js";

export {
  cx,
  buttonClass,
  fieldState,
  pillClass,
  pillIcon,
  toastClass,
  toastIcon,
  cooldownPercent,
  cooldownSeconds,
  cooldownVisualPhase,
  celebrationPieces,
  type ConfettiPiece,
  gaugeSegments,
  reserveFillPercent,
  wordmarkClass,
  type ButtonVariant,
  type ButtonSize,
  type FieldState,
  type PillState,
  type ToastKind,
  type GaugeMode,
  type CooldownVisualPhase,
  type SizeToken,
} from "./variants.js";
