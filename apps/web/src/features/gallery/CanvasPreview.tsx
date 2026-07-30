/**
 * Client-side canvas preview for gallery cards (FEN-1863).
 *
 * When no worker-rendered thumbnail exists yet, we fall back to fetching the
 * latest durable snapshot blob from Convex storage and decoding it directly in
 * the browser. The palette-indexed binary is tiny (1 byte/pixel, ≤10 KB for a
 * 100×100 canvas), so the fetch is fast even over a mobile connection.
 *
 * Rendering: `decodeSnapshot` extracts the pixel array and `paletteToRGBA`
 * converts it to an RGBA buffer that goes into `ImageData` → `putImageData`.
 * The <canvas> element is CSS-scaled to fill its container (aspect-ratio is
 * handled by the parent `.gallery__thumb`); `image-rendering: pixelated`
 * keeps the pixel grid crisp when upscaled.
 */
import { useEffect, useRef, useState } from "react";
import { decodeSnapshot, paletteToRGBA } from "@canvas/protocol";

/**
 * Renders a gallery card preview directly from the inline pixel grid returned by
 * `listPublicCanvases` (FEN-1877 / FEN-1863). No network fetch required — the
 * data is already in the Convex query result, so the preview is always up-to-date.
 *
 * Accepts the flat row-major pixel grid (palette index per cell, 0 = empty/white)
 * from the backend and renders it to a <canvas> element using the shared palette.
 */
export function PixelGridPreview({
  pixelGrid,
  width,
  height,
}: {
  pixelGrid: number[];
  width: number;
  height: number;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || width <= 0 || height <= 0) return;
    el.width = width;
    el.height = height;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(paletteToRGBA(new Uint8Array(pixelGrid)));
    ctx.putImageData(imageData, 0, 0);
  }, [pixelGrid, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="gallery__thumbCanvas"
      aria-hidden
    />
  );
}

type RenderState = "loading" | "ready" | "error";

export function CanvasPreview({ snapshotUrl }: { snapshotUrl: string }): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<RenderState>("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");

    fetch(snapshotUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const snap = decodeSnapshot(buf);
        const el = canvasRef.current;
        if (!el) return;
        el.width = snap.width;
        el.height = snap.height;
        const ctx = el.getContext("2d");
        if (!ctx) { setState("error"); return; }
        const imageData = ctx.createImageData(snap.width, snap.height);
        imageData.data.set(paletteToRGBA(snap.pixels));
        ctx.putImageData(imageData, 0, 0);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => { cancelled = true; };
  }, [snapshotUrl]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="gallery__thumbCanvas"
        aria-hidden
        style={{ display: state === "ready" ? "block" : "none" }}
      />
      {state !== "ready" && <div className="gallery__thumbPlaceholder" aria-hidden />}
    </>
  );
}
