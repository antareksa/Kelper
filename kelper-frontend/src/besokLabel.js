// The temp "PACK BESOK" label: 33 x 15 mm (client-requested 2026-10-12), printed on
// the label printer and stuck on a box that has no real resi yet. Option C of the
// mockup the client approved: the title and the date on top, a Code 128 barcode
// 6 mm tall, and the code in readable letters under it.
//
// Drawn as ONE svg whose units are millimetres, so every position is exact and the
// printed page is vector: the bars are 0.25 mm (2 dots at 203 dpi) and sit on the
// printer's dot grid, which is what lets a scanner read a barcode this small.

import { code128Modules } from './Barcode';

export const BESOK_LABEL_MM = { w: 33, h: 15 };
const MODULE_MM = 0.25;

// 'B' + 8 digits is the current code (see routes/packing.js's newBesokCode).
// BESOK-XXXXXXXX is the older one: boxes labelled before 2026-10-12 still carry it,
// and the server still accepts it when it is scanned.
export function isBesokCode(value) {
  return /^(B\d{8}|BESOK-[0-9A-F]{8})$/i.test(String(value ?? '').trim());
}

// What is written in letters under the barcode ("B12345678" -> "BESOK 12345678").
export function besokCodeText(code) {
  return /^B\d{8}$/i.test(code) ? `BESOK ${String(code).slice(1)}` : String(code);
}

// dd/mm in Jakarta time, whatever timezone the PC itself is set to.
export function todayDdMm() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderBesokLabelSvg(code, date = todayDdMm()) {
  const modules = code128Modules(code);
  const { w, h } = BESOK_LABEL_MM;
  // A current code is 101 modules = 25.25 mm. An older, longer code would not fit
  // at 0.25 mm, so it is squeezed to the width available (thinner bars, still valid).
  let moduleMm = MODULE_MM;
  if (modules.length * moduleMm > w - 2) moduleMm = (w - 2) / modules.length;
  const widthMm = modules.length * moduleMm;
  const x0 = Math.round((w - widthMm) / 2 / 0.125) * 0.125; // snap the left edge to the printer's dot grid
  const barTop = 4.6;
  const barHeight = 6;

  const rects = [];
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === '1') {
      let j = i;
      while (j < modules.length && modules[j] === '1') j += 1;
      rects.push(`<rect x="${(x0 + i * moduleMm).toFixed(4)}" y="${barTop}" width="${((j - i) * moduleMm).toFixed(4)}" height="${barHeight}"/>`);
      i = j;
    } else {
      i += 1;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" style="display:block">
  <rect width="${w}" height="${h}" fill="#fff"/>
  <text x="1.2" y="3.7" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="3" fill="#000">PACK BESOK</text>
  <text x="${w - 1.2}" y="3.7" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="2.6" fill="#000">${escapeXml(date)}</text>
  <g fill="#000" shape-rendering="crispEdges">${rects.join('')}</g>
  <text x="${w / 2}" y="13.7" text-anchor="middle" font-family="Consolas, 'Courier New', monospace" font-weight="700" font-size="2.5" fill="#000">${escapeXml(besokCodeText(code))}</text>
</svg>`;
}
