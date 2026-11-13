// Inline SVG charts for the OEMS Exposure Statistics Tool. Each function returns an SVG string.
// Thin marks, one axis per chart, hover titles on every mark, the OEL in red and the action level in
// amber on every exposure chart, and data in OEMS navy. No library.

import { qnorm, dnorm } from "./numeric.js";
import { BANDS, fmt, pct, Z95 } from "./engine.js";

const NAVY = "#0f2b55", ACCENT = "#38bdf8", OEL = "#b91c1c", AL = "#b45309", GRID = "#e5e7eb", INK = "#374151", MUTED = "#6b7280";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function niceLogTicks(lo, hi) {
  const ticks = [];
  const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
  for (let e = e0; e <= e1; e++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) ticks.push(v); }
  if (ticks.length > 8) return ticks.filter(v => Math.log10(v) % 1 === 0);
  return ticks;
}
function tickLabel(v) { return v >= 1000 ? v.toFixed(0) : v >= 10 ? String(Math.round(v * 10) / 10) : v >= 1 ? String(Math.round(v * 100) / 100) : v.toPrecision(2).replace(/0+$/, "").replace(/\.$/, ""); }

/**
 * The stoplight strip: four AIHA bands, the 95th percentile marker with its confidence whisker,
 * and the probability of each band under it. ratio values are fractions of the OEL.
 */
export function stoplight({ marker, lo, hi, probs, status }) {
  const W = 760, H = 150, padL = 8, padR = 8, top = 62, bh = 36, lane = 36;
  const bw = (W - padL - padR) / 4;
  // piecewise log position: each band takes a quarter of the strip
  const edges = [0.01, 0.1, 0.5, 1, 10];
  const pos = r => {
    if (!(r > 0)) return null;
    const v = Math.min(Math.max(r, 0.0101), 9.9);
    for (let k = 0; k < 4; k++) {
      if (v < edges[k + 1] || k === 3) {
        const f = (Math.log(v) - Math.log(edges[k])) / (Math.log(edges[k + 1]) - Math.log(edges[k]));
        return padL + bw * k + Math.min(Math.max(f, 0), 1) * bw;
      }
    }
    return null;
  };
  const fills = ["#bbf7d0", "#d9f99d", "#fde68a", "#fecaca"], inks = ["#14532d", "#3f6212", "#92400e", "#991b1b"];
  let s = `<svg class="chart stoplight" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stoplight strip: the 95th percentile against the AIHA exposure bands">`;
  // scale labels
  s += `<text x="${padL}" y="14" font-size="12" fill="${MUTED}">1% of OEL</text>`;
  s += `<text x="${padL + bw}" y="14" text-anchor="middle" font-size="12" fill="${MUTED}">10%</text>`;
  s += `<text x="${padL + 2 * bw}" y="14" text-anchor="middle" font-size="12" fill="${MUTED}">50%</text>`;
  s += `<text x="${padL + 3 * bw}" y="14" text-anchor="middle" font-size="12" font-weight="700" fill="${OEL}">OEL</text>`;
  s += `<text x="${W - padR}" y="14" text-anchor="end" font-size="12" fill="${MUTED}">10 × OEL</text>`;
  // band edges up through the marker lane
  for (let k = 1; k <= 3; k++) s += `<line x1="${padL + bw * k}" x2="${padL + bw * k}" y1="18" y2="${top}" stroke="${k === 3 ? OEL : GRID}" stroke-width="${k === 3 ? 1.5 : 1}" ${k === 3 ? "" : 'stroke-dasharray="3 3"'}/>`;
  // bands
  BANDS.forEach((b, k) => {
    const x = padL + bw * k;
    s += `<rect x="${x + 1}" y="${top}" width="${bw - 2}" height="${bh}" rx="6" fill="${fills[k]}"><title>${esc(b.name)}: ${esc(b.label)} (${esc(b.text)})</title></rect>`;
    s += `<text x="${x + bw / 2}" y="${top + bh / 2 + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="${inks[k]}">${esc(b.short)}</text>`;
    s += `<text x="${x + bw / 2}" y="${top + bh + 18}" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(b.text)}</text>`;
    if (probs) s += `<text x="${x + bw / 2}" y="${top + bh + 36}" text-anchor="middle" font-size="13" font-weight="700" fill="${INK}">${esc(pct(probs[k]))}<title>Probability that the 95th percentile is in this band</title></text>`;
  });
  // marker lane
  const xm = pos(marker);
  const ym = top - lane / 2 - 4;
  if (xm !== null) {
    const xl = pos(lo), xh = pos(hi);
    if (xl !== null && xh !== null) {
      s += `<line x1="${xl}" x2="${xh}" y1="${ym}" y2="${ym}" stroke="${NAVY}" stroke-width="3" stroke-linecap="round" opacity="0.85"><title>95% confidence range of the 95th percentile: ${esc(pct(lo))} to ${esc(pct(hi))} of the OEL</title></line>`;
      s += `<line x1="${xl}" x2="${xl}" y1="${ym - 8}" y2="${ym + 8}" stroke="${NAVY}" stroke-width="2.5"/>`;
      s += `<line x1="${xh}" x2="${xh}" y1="${ym - 8}" y2="${ym + 8}" stroke="${NAVY}" stroke-width="2.5"/>`;
    }
    const colour = status === "go" ? "#15803d" : status === "nogo" ? "#b91c1c" : "#b45309";
    s += `<circle cx="${xm}" cy="${ym}" r="8" fill="#fff" stroke="${colour}" stroke-width="3.5"><title>95th percentile: ${esc(pct(marker))} of the OEL</title></circle>`;
    s += `<polygon points="${xm - 7},${top - 10} ${xm + 7},${top - 10} ${xm},${top - 1}" fill="${colour}"><title>95th percentile: ${esc(pct(marker))} of the OEL</title></polygon>`;
  } else {
    s += `<text x="${W / 2}" y="${ym + 4}" text-anchor="middle" font-size="12" fill="${MUTED}">no estimate yet</text>`;
  }
  s += `</svg>`;
  return s;
}

/** Horizontal bar of the posterior probability of each AIHA band (with the prior-weighted version if given). */
export function bandBars(probs, probsPrior) {
  const W = 760, rowH = 28, rows = probsPrior ? 2 : 1, H = rows * (rowH + 10) + 6;
  const fills = ["#86efac", "#bef264", "#fcd34d", "#fca5a5"], inks = ["#14532d", "#3f6212", "#78350f", "#7f1d1d"];
  let s = `<svg class="chart bandbars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Probability of each AIHA exposure band">`;
  const draw = (p, y, label) => {
    let x = 110;
    const total = W - 118;
    s += `<text x="0" y="${y + rowH / 2 + 4}" font-size="11.5" fill="${INK}">${esc(label)}</text>`;
    p.forEach((v, k) => {
      const w = Math.max(0, v * total - 2);
      if (w > 0) {
        s += `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="4" fill="${fills[k]}"><title>${esc(BANDS[k].label)}: ${esc(pct(v))}</title></rect>`;
        if (w > 44) s += `<text x="${x + w / 2}" y="${y + rowH / 2 + 4}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${inks[k]}">${esc(pct(v))}</text>`;
      }
      x += v * total;
    });
  };
  draw(probs, 2, "Data alone");
  if (probsPrior) draw(probsPrior, rowH + 12, "With decision prior");
  s += `</svg>`;
  return s;
}

function frame(W, H, m) { return { x0: m.l, x1: W - m.r, y0: m.t, y1: H - m.b, w: W - m.l - m.r, h: H - m.t - m.b }; }

/** Sequence plot: each result in order (or by date), log scale, with the OEL, action level and 95th percentile. */
export function sequencePlot({ rows, oel, al, x95, unit, byWorker }) {
  const W = 760, H = 300, m = { l: 62, r: 16, t: 18, b: 44 };
  const f = frame(W, H, m);
  const vals = rows.map(r => r.type === "exact" ? r.value : r.type === "lt" ? r.hi : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi));
  const allv = [...vals, oel, al || oel, x95 || oel].filter(v => v > 0);
  const lo = Math.min(...allv) / 1.6, hi = Math.max(...allv) * 1.6;
  const ly = v => f.y1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * f.h;
  const byDate = rows.length && rows.every(r => r.date);
  const order = rows.map((r, i) => i);
  if (byDate) order.sort((a, b) => rows[a].date - rows[b].date);
  const n = rows.length;
  const xs = i => f.x0 + (n === 1 ? f.w / 2 : (i + 0.5) / n * f.w);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sample results in sequence">`;
  for (const t of niceLogTicks(lo, hi)) {
    s += `<line x1="${f.x0}" x2="${f.x1}" y1="${ly(t)}" y2="${ly(t)}" stroke="${GRID}"/>`;
    s += `<text x="${f.x0 - 8}" y="${ly(t) + 4}" text-anchor="end" font-size="11" fill="${MUTED}">${tickLabel(t)}</text>`;
  }
  s += `<text transform="translate(14 ${f.y0 + f.h / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(unit)} (log scale)</text>`;
  const ref = (v, colour, label, dash) => {
    if (!(v > 0)) return;
    s += `<line x1="${f.x0}" x2="${f.x1}" y1="${ly(v)}" y2="${ly(v)}" stroke="${colour}" stroke-width="1.5" ${dash ? 'stroke-dasharray="6 4"' : ""}><title>${esc(label)}: ${esc(fmt(v))} ${esc(unit)}</title></line>`;
    s += `<text x="${f.x1 - 4}" y="${ly(v) - 4}" text-anchor="end" font-size="11" font-weight="600" fill="${colour}">${esc(label)}</text>`;
  };
  ref(oel, OEL, "OEL");
  ref(al, AL, "Action level");
  ref(x95, NAVY, "95th percentile", true);
  const workers = [...new Set(rows.map(r => r.worker).filter(Boolean))];
  // categorical palette validated for colour-vision separation (dataviz reference palette, light mode)
  const palette = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const colourFor = r => byWorker && workers.length <= 8 && r.worker ? palette[workers.indexOf(r.worker) % palette.length] : NAVY;
  order.forEach((ri, k) => {
    const r = rows[ri], v = vals[ri], x = xs(k), y = ly(v), c = colourFor(r);
    const tip = `Sample ${r.index}: ${r.display} ${unit}${r.worker ? " · " + r.worker : ""}${r.dateText ? " · " + r.dateText : ""}${r.group ? " · " + r.group : ""}${r.censored ? " (censored)" : ""}`;
    if (r.type === "lt") s += `<polygon points="${x - 6},${y - 6} ${x + 6},${y - 6} ${x},${y + 6}" fill="#fff" stroke="${c}" stroke-width="2"><title>${esc(tip)}</title></polygon>`;
    else if (r.type === "gt") s += `<polygon points="${x - 6},${y + 6} ${x + 6},${y + 6} ${x},${y - 6}" fill="#fff" stroke="${c}" stroke-width="2"><title>${esc(tip)}</title></polygon>`;
    else if (r.type === "interval") s += `<line x1="${x}" x2="${x}" y1="${ly(r.lo)}" y2="${ly(r.hi)}" stroke="${c}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="${c}" stroke-width="2"><title>${esc(tip)}</title></circle>`;
    else s += `<circle cx="${x}" cy="${y}" r="5.5" fill="${c}" stroke="#fff" stroke-width="1.5"><title>${esc(tip)}</title></circle>`;
    if (n <= 30) s += `<text x="${x}" y="${f.y1 + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">${byDate ? esc(r.date.toISOString().slice(5, 10)) : r.index}</text>`;
  });
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${MUTED}">${byDate ? "Sample date (month-day)" : "Sample order as entered"}</text>`;
  if (byWorker && workers.length >= 2 && workers.length <= 8) {
    let lx = f.x0;
    workers.forEach((w, i) => {
      s += `<circle cx="${lx + 6}" cy="${f.y0 - 6}" r="5" fill="${palette[i % palette.length]}"/><text x="${lx + 15}" y="${f.y0 - 2}" font-size="11" fill="${INK}">${esc(w)}</text>`;
      lx += 24 + 7 * String(w).length;
    });
  }
  s += `</svg>`;
  return s;
}

/** Lognormal probability (Q-Q) plot with the fitted line. */
export function qqPlot({ qq, mu, sigma, unit }) {
  const W = 760, H = 300, m = { l: 62, r: 16, t: 14, b: 44 };
  const f = frame(W, H, m);
  if (!qq || qq.length === 0) return "";
  const xmin = Math.min(-2.2, ...qq.map(p => p.x)) - 0.2, xmax = Math.max(2.2, ...qq.map(p => p.x)) + 0.2;
  const ys = qq.map(p => p.y);
  const fitLo = mu + sigma * xmin, fitHi = mu + sigma * xmax;
  const ymin = Math.min(...ys, fitLo) - 0.2, ymax = Math.max(...ys, fitHi) + 0.2;
  const X = x => f.x0 + (x - xmin) / (xmax - xmin) * f.w;
  const Y = y => f.y1 - (y - ymin) / (ymax - ymin) * f.h;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lognormal probability plot">`;
  for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    const x = qnorm(p);
    if (x < xmin || x > xmax) continue;
    s += `<line x1="${X(x)}" x2="${X(x)}" y1="${f.y0}" y2="${f.y1}" stroke="${GRID}"/>`;
    s += `<text x="${X(x)}" y="${f.y1 + 16}" text-anchor="middle" font-size="11" fill="${MUTED}">${Math.round(p * 100)}%</text>`;
  }
  for (const t of niceLogTicks(Math.exp(ymin), Math.exp(ymax))) {
    s += `<line x1="${f.x0}" x2="${f.x1}" y1="${Y(Math.log(t))}" y2="${Y(Math.log(t))}" stroke="${GRID}"/>`;
    s += `<text x="${f.x0 - 8}" y="${Y(Math.log(t)) + 4}" text-anchor="end" font-size="11" fill="${MUTED}">${tickLabel(t)}</text>`;
  }
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${MUTED}">Cumulative probability (normal scale)</text>`;
  s += `<text transform="translate(14 ${f.y0 + f.h / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(unit)} (log scale)</text>`;
  s += `<line x1="${X(xmin)}" x2="${X(xmax)}" y1="${Y(fitLo)}" y2="${Y(fitHi)}" stroke="${ACCENT}" stroke-width="2"><title>Fitted lognormal: GM ${esc(fmt(Math.exp(mu)))}, GSD ${esc(fmt(Math.exp(sigma)))}</title></line>`;
  for (const p of qq) {
    const tip = `${p.v} ${unit}${p.censored ? " (censored, shown at its bound)" : ""}`;
    if (p.censored) s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="#fff" stroke="${NAVY}" stroke-width="2"><title>${esc(tip)}</title></circle>`;
    else s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5.5" fill="${NAVY}" stroke="#fff" stroke-width="1.5"><title>${esc(tip)}</title></circle>`;
  }
  s += `</svg>`;
  return s;
}

/** Fitted lognormal density on a log axis with the samples as a rug, the OEL, the AL and the exceedance area. */
export function densityPlot({ mu, sigma, rows, oel, al, unit, x95 }) {
  const W = 760, H = 240, m = { l: 16, r: 16, t: 14, b: 44 };
  const f = frame(W, H, m);
  const vals = rows.map(r => r.type === "exact" ? r.value : r.type === "lt" ? r.hi : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi));
  const lo = Math.min(Math.exp(mu - 3.2 * sigma), ...vals) / 1.3, hi = Math.max(Math.exp(mu + 3.2 * sigma), oel * 1.3, ...vals) * 1.3;
  const X = v => f.x0 + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * f.w;
  const dens = y => dnorm((y - mu) / sigma) / sigma;
  const peak = dens(mu);
  const Y = d => f.y1 - 18 - d / peak * (f.h - 18);
  const N = 160;
  let path = "", area = "";
  for (let i = 0; i <= N; i++) {
    const y = Math.log(lo) + (Math.log(hi) - Math.log(lo)) * i / N;
    const px = X(Math.exp(y)), py = Y(dens(y));
    path += (i ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
  }
  const lnO = Math.log(oel);
  if (lnO < Math.log(hi)) {
    area = `M${X(oel).toFixed(1)} ${(f.y1 - 18).toFixed(1)}`;
    for (let i = 0; i <= 60; i++) { const y = lnO + (Math.log(hi) - lnO) * i / 60; area += `L${X(Math.exp(y)).toFixed(1)} ${Y(dens(y)).toFixed(1)}`; }
    area += `L${X(hi).toFixed(1)} ${(f.y1 - 18).toFixed(1)}Z`;
  }
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fitted lognormal exposure distribution">`;
  for (const t of niceLogTicks(lo, hi)) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${f.y0}" y2="${f.y1 - 18}" stroke="${GRID}"/>`;
    s += `<text x="${X(t)}" y="${f.y1 - 2}" text-anchor="middle" font-size="11" fill="${MUTED}">${tickLabel(t)}</text>`;
  }
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(unit)} (log scale)</text>`;
  if (area) s += `<path d="${area}" fill="#fecaca" opacity="0.8"><title>Exposures above the OEL (the exceedance fraction)</title></path>`;
  s += `<path d="${path}" fill="none" stroke="${NAVY}" stroke-width="2"><title>Fitted lognormal: GM ${esc(fmt(Math.exp(mu)))}, GSD ${esc(fmt(Math.exp(sigma)))}</title></path>`;
  const vline = (v, colour, label, dash, row) => {
    if (!(v > lo && v < hi)) return;
    s += `<line x1="${X(v)}" x2="${X(v)}" y1="${f.y0}" y2="${f.y1 - 18}" stroke="${colour}" stroke-width="1.5" ${dash ? 'stroke-dasharray="6 4"' : ""}><title>${esc(label)}: ${esc(fmt(v))} ${esc(unit)}</title></line>`;
    s += `<text x="${X(v) + 4}" y="${f.y0 + 11 + row * 14}" font-size="11" font-weight="600" fill="${colour}">${esc(label)}</text>`;
  };
  vline(oel, OEL, "OEL", false, 0);
  vline(al, AL, "AL", false, 1);
  vline(x95, NAVY, "95th pct", true, 2);
  rows.forEach((r, i) => {
    const v = vals[i];
    s += `<line x1="${X(v)}" x2="${X(v)}" y1="${f.y1 - 16}" y2="${f.y1 - 4}" stroke="${r.censored ? "#94a3b8" : NAVY}" stroke-width="2"><title>Sample ${r.index}: ${esc(r.display)} ${esc(unit)}</title></line>`;
  });
  s += `</svg>`;
  return s;
}

/** Dot plot by worker, with each worker's geometric mean. */
export function workerPlot({ rows, workers, oel, al, unit }) {
  const W = 760, rowH = 28, m = { l: 110, r: 16, t: 16, b: 40 };
  const H = m.t + m.b + workers.length * rowH;
  const f = frame(W, H, m);
  const vals = rows.map(r => r.type === "exact" ? r.value : r.type === "lt" ? r.hi : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi));
  const allv = [...vals, oel, al || oel];
  const lo = Math.min(...allv) / 1.5, hi = Math.max(...allv) * 1.5;
  const X = v => f.x0 + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * f.w;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Results by worker">`;
  for (const t of niceLogTicks(lo, hi)) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${f.y0}" y2="${f.y1}" stroke="${GRID}"/>`;
    s += `<text x="${X(t)}" y="${f.y1 + 16}" text-anchor="middle" font-size="11" fill="${MUTED}">${tickLabel(t)}</text>`;
  }
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(unit)} (log scale)</text>`;
  const vline = (v, colour, label) => { if (v > lo && v < hi) { s += `<line x1="${X(v)}" x2="${X(v)}" y1="${f.y0}" y2="${f.y1}" stroke="${colour}" stroke-width="1.5"><title>${esc(label)}: ${esc(fmt(v))}</title></line><text x="${X(v) + 4}" y="${f.y0 + 10}" font-size="11" font-weight="600" fill="${colour}">${esc(label)}</text>`; } };
  vline(oel, OEL, "OEL"); vline(al, AL, "AL");
  workers.forEach((w, k) => {
    const y = f.y0 + rowH * k + rowH / 2;
    s += `<text x="${f.x0 - 10}" y="${y + 4}" text-anchor="end" font-size="11.5" fill="${INK}">${esc(w.worker)} <tspan fill="${MUTED}">(n=${w.n})</tspan></text>`;
    s += `<line x1="${f.x0}" x2="${f.x1}" y1="${y}" y2="${y}" stroke="${GRID}"/>`;
    rows.forEach((r, i) => {
      if (r.worker !== w.worker) return;
      const v = vals[i];
      s += `<circle cx="${X(v)}" cy="${y}" r="5" fill="${r.censored ? "#fff" : NAVY}" stroke="${NAVY}" stroke-width="2"><title>${esc(w.worker)}: ${esc(r.display)} ${esc(unit)}${r.dateText ? " · " + esc(r.dateText) : ""}</title></circle>`;
    });
    s += `<rect x="${X(w.gm) - 2}" y="${y - 9}" width="4" height="18" rx="1" fill="${ACCENT}"><title>${esc(w.worker)} geometric mean: ${esc(fmt(w.gm))} ${esc(unit)}</title></rect>`;
  });
  s += `</svg>`;
  return s;
}

/** Two fitted lognormal densities for the group comparison. */
export function comparePlot({ A, B, names, oel, al, unit }) {
  const W = 760, H = 240, m = { l: 16, r: 16, t: 14, b: 44 };
  const f = frame(W, H, m);
  const lo = Math.min(Math.exp(A.mu - 3 * A.sigma), Math.exp(B.mu - 3 * B.sigma)) / 1.2;
  const hi = Math.max(Math.exp(A.mu + 3 * A.sigma), Math.exp(B.mu + 3 * B.sigma), oel * 1.2) * 1.2;
  const X = v => f.x0 + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * f.w;
  const dens = (fit, y) => dnorm((y - fit.mu) / fit.sigma) / fit.sigma;
  const peak = Math.max(dens(A, A.mu), dens(B, B.mu));
  const Y = d => f.y1 - 18 - d / peak * (f.h - 18);
  const curve = fit => { let p = ""; for (let i = 0; i <= 160; i++) { const y = Math.log(lo) + (Math.log(hi) - Math.log(lo)) * i / 160; p += (i ? "L" : "M") + X(Math.exp(y)).toFixed(1) + " " + Y(dens(fit, y)).toFixed(1); } return p; };
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Comparison of the two groups">`;
  for (const t of niceLogTicks(lo, hi)) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${f.y0}" y2="${f.y1 - 18}" stroke="${GRID}"/>`;
    s += `<text x="${X(t)}" y="${f.y1 - 2}" text-anchor="middle" font-size="11" fill="${MUTED}">${tickLabel(t)}</text>`;
  }
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(unit)} (log scale)</text>`;
  if (oel > lo && oel < hi) s += `<line x1="${X(oel)}" x2="${X(oel)}" y1="${f.y0}" y2="${f.y1 - 18}" stroke="${OEL}" stroke-width="1.5"/><text x="${X(oel) + 4}" y="${f.y0 + 26}" font-size="11" font-weight="600" fill="${OEL}">OEL</text>`;
  if (al && al > lo && al < hi) s += `<line x1="${X(al)}" x2="${X(al)}" y1="${f.y0}" y2="${f.y1 - 18}" stroke="${AL}" stroke-width="1.5"/><text x="${X(al) + 4}" y="${f.y0 + 40}" font-size="11" font-weight="600" fill="${AL}">AL</text>`;
  s += `<path d="${curve(A)}" fill="none" stroke="${NAVY}" stroke-width="2"><title>${esc(names[0])}: GM ${esc(fmt(Math.exp(A.mu)))}, GSD ${esc(fmt(Math.exp(A.sigma)))}</title></path>`;
  s += `<path d="${curve(B)}" fill="none" stroke="#0e7490" stroke-width="2" stroke-dasharray="7 4"><title>${esc(names[1])}: GM ${esc(fmt(Math.exp(B.mu)))}, GSD ${esc(fmt(Math.exp(B.sigma)))}</title></path>`;
  const lw = 7 * Math.max(String(names[0]).length, 4) + 40;
  s += `<line x1="${f.x0 + 4}" x2="${f.x0 + 28}" y1="${f.y0 + 8}" y2="${f.y0 + 8}" stroke="${NAVY}" stroke-width="2"/><text x="${f.x0 + 34}" y="${f.y0 + 12}" font-size="11" fill="${INK}">${esc(names[0])}</text>`;
  s += `<line x1="${f.x0 + 4 + lw}" x2="${f.x0 + 28 + lw}" y1="${f.y0 + 8}" y2="${f.y0 + 8}" stroke="#0e7490" stroke-width="2" stroke-dasharray="7 4"/><text x="${f.x0 + 34 + lw}" y="${f.y0 + 12}" font-size="11" fill="${INK}">${esc(names[1])}</text>`;
  s += `</svg>`;
  return s;
}

/** Posterior histogram of the 95th percentile ratio to the OEL (the Bayesian decision picture). */
export function posteriorPlot({ draws, oel, unit }) {
  const W = 760, H = 200, m = { l: 16, r: 16, t: 14, b: 40 };
  const f = frame(W, H, m);
  const r = Array.from(draws).map(v => v / oel).filter(v => v > 0).sort((a, b) => a - b);
  if (!r.length) return "";
  const lo = Math.max(r[Math.floor(r.length * 0.002)] / 1.3, 1e-4), hi = r[Math.floor(r.length * 0.998)] * 1.3;
  const nb = 48;
  const bins = new Array(nb).fill(0);
  for (const v of r) { const k = Math.floor((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * nb); if (k >= 0 && k < nb) bins[k]++; }
  const peak = Math.max(...bins);
  const X = v => f.x0 + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * f.w;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Posterior distribution of the 95th percentile as a fraction of the OEL">`;
  for (const t of [0.01, 0.1, 0.5, 1, 2, 5, 10]) {
    if (t < lo || t > hi) continue;
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${f.y0}" y2="${f.y1}" stroke="${GRID}"/>`;
    s += `<text x="${X(t)}" y="${f.y1 + 16}" text-anchor="middle" font-size="11" fill="${MUTED}">${t === 1 ? "OEL" : pct(t)}</text>`;
  }
  const bw = f.w / nb;
  bins.forEach((c, k) => {
    const x0 = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k / nb), x1 = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * (k + 1) / nb);
    const over = x0 >= 1;
    const h = c / peak * (f.h - 4);
    s += `<rect x="${f.x0 + k * bw + 1}" y="${f.y1 - h}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="2" fill="${over ? "#f87171" : "#60a5fa"}"><title>${esc(pct(x0))} – ${esc(pct(x1))} of the OEL: ${esc(pct(c / r.length))} of draws</title></rect>`;
  });
  s += `<line x1="${X(1)}" x2="${X(1)}" y1="${f.y0}" y2="${f.y1}" stroke="${OEL}" stroke-width="1.5"/>`;
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="${MUTED}">95th percentile as a fraction of the OEL (posterior draws)</text>`;
  s += `</svg>`;
  return s;
}

/** Per-sample SAE chart: each sample's ratio to the OEL with its confidence limits. */
export function saePlot({ perSample, unit }) {
  const W = 760, H = 220, m = { l: 16, r: 16, t: 14, b: 40 };
  const f = frame(W, H, m);
  const n = perSample.length;
  const ymax = Math.max(1.3, ...perSample.map(p => p.ucl)) * 1.05;
  const Y = v => f.y1 - v / ymax * f.h;
  const X = i => f.x0 + (i + 0.5) / n * f.w;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each sample against the OEL with its confidence limits">`;
  for (const t of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]) {
    if (t > ymax) break;
    s += `<line x1="${f.x0}" x2="${f.x1}" y1="${Y(t)}" y2="${Y(t)}" stroke="${t === 1 ? OEL : GRID}" stroke-width="${t === 1 ? 1.5 : 1}"/>`;
    s += `<text x="${f.x1 - 2}" y="${Y(t) - 3}" text-anchor="end" font-size="10.5" fill="${t === 1 ? OEL : MUTED}">${t === 1 ? "OEL" : pct(t)}</text>`;
  }
  const col = { compliant: "#15803d", possible: "#b45309", over: "#b91c1c" };
  perSample.forEach((p, i) => {
    const x = X(i);
    s += `<line x1="${x}" x2="${x}" y1="${Y(Math.max(p.lcl, 0))}" y2="${Y(p.ucl)}" stroke="${col[p.cls]}" stroke-width="2"><title>Sample ${p.index}: ${esc(p.display)} ${esc(unit)} = ${esc(pct(p.y))} of the OEL; limits ${esc(pct(p.lcl))} – ${esc(pct(p.ucl))}. ${esc(p.text)}</title></line>`;
    s += `<circle cx="${x}" cy="${Y(p.y)}" r="5" fill="${col[p.cls]}" stroke="#fff" stroke-width="1.5"><title>Sample ${p.index}: ${esc(p.display)} ${esc(unit)} = ${esc(pct(p.y))} of the OEL. ${esc(p.text)}</title></circle>`;
    if (n <= 30) s += `<text x="${x}" y="${f.y1 + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">${p.index}</text>`;
  });
  s += `<text x="${f.x0 + f.w / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="${MUTED}">Sample (fraction of the OEL with ± SAE limits)</text>`;
  s += `</svg>`;
  return s;
}
