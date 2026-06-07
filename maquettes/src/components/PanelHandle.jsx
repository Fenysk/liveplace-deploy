// PanelHandle — the HONEST affordance that replaces the decorative `.lp-hud::before`
// (F1, AC-R2-4). It is a real focusable control: drag it (pointer) to close/open the
// dock, OR activate it with Enter/Space/Arrows (keyboard path — a swipe alone is not
// discoverable, Paradox of the Active User). The grab-bar is rendered inside a real
// <button role="separator"> so SR users get state + an action, never a fake handle.
//
// Behaviour is owned by the parent (MobileSceneR2): this component reports drag delta
// and intent; the parent commits the snap past --dock-snap-ratio.
//
//   open        current panel state (drives aria-expanded + grip affordance)
//   onToggle()  keyboard / tap activation (the guaranteed non-gestural path)
//   onDrag(dy)  live pointer delta in px (parent previews the slide)
//   onDragEnd(dy) pointer release → parent decides snap open/closed
export default function PanelHandle({ open = true, onToggle, onDrag, onDragEnd }) {
  const start = (e) => {
    const y0 = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    let last = 0;
    const move = (ev) => { last = ev.clientY - y0; onDrag?.(last); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onDragEnd?.(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const key = (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onToggle?.();
    }
  };

  return (
    <button
      type="button"
      role="separator"
      aria-label={open ? "Réduire le panneau" : "Ouvrir le panneau"}
      aria-expanded={open}
      onPointerDown={start}
      onKeyDown={key}
      onClick={onToggle}
      className="group mx-auto flex w-full max-w-[160px] cursor-grab touch-none flex-col items-center justify-center py-2 active:cursor-grabbing focus-visible:outline-none"
      style={{ minHeight: "var(--target-min)" }}
    >
      {/* The grip bar — now reacts: widens/colours on hover/focus to SIGNAL it moves. */}
      <span
        className="h-1.5 w-10 rounded-full transition-[width,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:w-12 group-focus-visible:w-12"
        style={{ background: "var(--ui-border-strong)" }}
      />
      <span
        aria-hidden
        className="mt-1 text-[var(--text-xs)] font-semibold leading-none text-[var(--ui-text-tertiary)] opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {open ? "glisser pour réduire" : "glisser pour ouvrir"}
      </span>
    </button>
  );
}
