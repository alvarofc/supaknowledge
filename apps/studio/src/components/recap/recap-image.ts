import { monthLabel, recapKpis } from "@/lib/recap";
import type { Recap } from "@/lib/recap";

const WIDTH = 1200;
const PAD = 56;
const COLS = 3;
const CELL_H = 156;
const HEADER_H = 120;
const FOOTER_H = 64;
const SANS = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Source Code Pro Variable", ui-monospace, monospace';

/** Theme colours from the page's CSS variables, so the image matches light or dark mode. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--surface", "#ffffff"),
    line: v("--line", "#e4e4e4"),
    fg: v("--fg", "#171717"),
    muted: v("--muted", "#525252"),
    subtle: v("--subtle", "#6b6b6b"),
    brand: v("--brand", "#3ecf8e"),
  };
}

/** Shortens `text` with an ellipsis until it fits `max` pixels in the current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * Draws the recap card on a canvas and returns it as a PNG, entirely in the browser (no external service).
 * Same KPIs as the page and the Slack text: all three come from recapKpis().
 */
export async function renderRecapPng(r: Recap, scopeName: string): Promise<Blob> {
  try {
    await Promise.all([document.fonts.load(`600 36px ${SANS}`), document.fonts.load(`400 14px ${MONO}`)]);
  } catch {
    // fonts not loadable: the canvas falls back to system fonts
  }
  const kpis = recapKpis(r);
  const rows = Math.ceil(kpis.length / COLS);
  const height = PAD + HEADER_H + rows * CELL_H + FOOTER_H;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw images");
  ctx.scale(scale, scale);
  const c = palette();

  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.textBaseline = "alphabetic";

  // header
  const inner = WIDTH - PAD * 2;
  ctx.fillStyle = c.fg;
  ctx.font = `600 36px ${SANS}`;
  ctx.fillText(fitText(ctx, scopeName, inner), PAD, PAD + 36);
  ctx.fillStyle = c.muted;
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText(`Knowledge recap, ${monthLabel(r.month)}`, PAD, PAD + 74);

  // KPI grid with hairlines
  const top = PAD + HEADER_H;
  const cellW = inner / COLS;
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD + 0.5, top + 0.5, inner - 1, rows * CELL_H - 1);
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.round(PAD + cellW * i) + 0.5, top);
    ctx.lineTo(Math.round(PAD + cellW * i) + 0.5, top + rows * CELL_H);
    ctx.stroke();
  }
  for (let j = 1; j < rows; j++) {
    ctx.beginPath();
    ctx.moveTo(PAD, top + CELL_H * j + 0.5);
    ctx.lineTo(PAD + inner, top + CELL_H * j + 0.5);
    ctx.stroke();
  }

  kpis.forEach((k, i) => {
    const x = PAD + (i % COLS) * cellW + 24;
    const y = top + Math.floor(i / COLS) * CELL_H;
    const w = cellW - 48;
    ctx.fillStyle = c.subtle;
    ctx.font = `400 14px ${MONO}`;
    ctx.fillText(fitText(ctx, k.label.toUpperCase(), w), x, y + 38);
    const numeric = /^\d/.test(k.value);
    ctx.fillStyle = k.empty ? c.subtle : c.fg;
    ctx.font = numeric ? `400 44px ${SANS}` : `500 28px ${SANS}`;
    ctx.fillText(fitText(ctx, k.value, w), x, y + (numeric ? 96 : 88));
    if (k.context) {
      ctx.fillStyle = c.muted;
      ctx.font = `400 16px ${SANS}`;
      ctx.fillText(fitText(ctx, k.context, w), x, y + 128);
    }
  });

  // footer: where the numbers come from
  ctx.fillStyle = c.brand;
  ctx.beginPath();
  ctx.arc(PAD + 5, height - PAD / 2 - 10, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.subtle;
  ctx.font = `400 15px ${SANS}`;
  ctx.fillText("Supaknowledge", PAD + 18, height - PAD / 2 - 5);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not create the image"))), "image/png"));
}
