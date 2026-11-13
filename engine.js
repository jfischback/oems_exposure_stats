// The analysis engine for the OEMS Exposure Statistics Tool. analyze(inputs) is pure: it reads the
// inputs object and returns a results object; the page (app.js) and the tests (tests/check.mjs) both
// call it. Nothing here touches the DOM.
//
// Outline
//   parseSamples      one sample per line: result (with <, > or a range), worker, date, group, note
//   gatekeeper        does the SEG's data belong together? (runs before any statistic)
//   saeAnalysis       sampling and analytical error: each sample's compliance call (OSHA / NIOSH rule)
//   fitLognormal      censored maximum likelihood, robust ROS, or substitution (DL/2, DL/sqrt2, DL)
//   lognormalSummary  GM, GSD, AM, 95th percentile, confidence limits, UTL95/95, exceedance fraction
//   bayesLognormal    Gibbs sampler: credible intervals, overexposure probability, AIHA band probabilities
//   workerAnalysis    between / within worker variance (ANOVA and Bayesian random effects)
//   compareGroups     before / after or group-to-group comparison
//   verdict           the plain-language compliance call and the stoplight band

import {
  pnorm, qnorm, qt, pt, qchisq, pf, pnt, qnt, kFactor, bisect, nelderMead, shapiroWilk,
  Rng, mean, variance, sd, quantile, median, ranks
} from "./numeric.js";

export const Z95 = 1.6448536269514722;

// ---------- Defaults ----------

export const DEFAULTS = {
  agent: "", unit: "mg/m³", seg: "", task: "", assessor: "", date: "", notes: "",
  oel: null, alFraction: 0.5, al: null,
  samplesText: "",
  analyzeGroup: "",           // "" = all samples; or one group label to run the main analysis on that group only
  ndMethod: "mle",            // mle | ros | half | sqrt2 | dl
  sae: { mode: "cv", saePct: 25, cvAnalytical: 0.10, cvSampling: 0.05 },
  gate: { sameTask: "yes", sameControls: "yes", sameRate: "yes", sameMethod: "yes", sameDuration: "yes", spread: "yes", noChange: "yes" },
  gateOverride: false, gateReason: "",
  decision: { goThreshold: 0.05, nogoThreshold: 0.30, usePrior: false, prior: [0.25, 0.25, 0.25, 0.25] },
  bayes: { draws: 6000, burn: 1000, seed: 20261113, sigmaMax: Math.log(10), singleGsd: 2.5, singleGsdSpread: 0.5 }
};

export const BANDS = [
  { id: 1, label: "< 10% of OEL", short: "<10%", lo: 0, hi: 0.1, name: "Category 1", css: "b1", text: "Highly controlled" },
  { id: 2, label: "10 – 50% of OEL", short: "10–50%", lo: 0.1, hi: 0.5, name: "Category 2", css: "b2", text: "Well controlled" },
  { id: 3, label: "50 – 100% of OEL", short: "50–100%", lo: 0.5, hi: 1.0, name: "Category 3", css: "b3", text: "Controlled" },
  { id: 4, label: "> 100% of OEL", short: ">100%", lo: 1.0, hi: Infinity, name: "Category 4", css: "b4", text: "Poorly controlled" }
];

export function bandOf(ratio) {
  if (!(ratio >= 0)) return null;
  return BANDS.find(b => ratio < b.hi) || BANDS[3];
}

// ---------- Parsing ----------

const SEP = /[\t;|,]/;

function parseResult(tok) {
  let s = String(tok).trim().replace(/\s+/g, "");
  if (!s) return { error: "no result" };
  s = s.replace(/[–—]/g, "-").replace(/^\[|\]$/g, "");
  let m;
  if ((m = s.match(/^(<|<=|≤|lt)(\d*\.?\d+(?:e-?\d+)?)$/i))) {
    const v = parseFloat(m[2]);
    if (!(v > 0)) return { error: "a non-detect needs a detection limit above zero" };
    return { type: "lt", lo: 0, hi: v, value: v };
  }
  if ((m = s.match(/^(>|>=|≥|gt)(\d*\.?\d+(?:e-?\d+)?)$/i))) {
    const v = parseFloat(m[2]);
    if (!(v > 0)) return { error: "a greater-than value must be above zero" };
    return { type: "gt", lo: v, hi: Infinity, value: v };
  }
  if ((m = s.match(/^(\d*\.?\d+(?:e-?\d+)?)-(\d*\.?\d+(?:e-?\d+)?)$/i))) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (!(a > 0 && b > a)) return { error: "a range needs 0 < low < high" };
    return { type: "interval", lo: a, hi: b, value: Math.sqrt(a * b) };
  }
  if ((m = s.match(/^(nd|n\.d\.|bdl|<)$/i))) return { error: "write a non-detect as < followed by the detection limit, e.g. <0.05" };
  const v = parseFloat(s);
  if (!Number.isFinite(v) || !/^\d*\.?\d+(e-?\d+)?$/i.test(s)) return { error: `"${tok}" is not a number` };
  if (v <= 0) return { error: "a result must be above zero (write a non-detect as <DL)" };
  return { type: "exact", lo: v, hi: v, value: v };
}

function parseDate(tok) {
  if (!tok) return null;
  const s = String(tok).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
  }
  if ((m = s.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/))) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Parse the sample text. One sample per line; columns separated by comma, tab, semicolon or pipe:
 * result, worker, date, group, note. A header row (first cell not a result) names the columns.
 * Results: 1.23, <0.05 (below the detection limit), >10 (above the range), 0.5-2 (a range).
 */
export function parseSamples(text) {
  const rows = [], errors = [];
  const lines = String(text || "").split(/\r?\n/);
  let cols = ["result", "worker", "date", "group", "note"];
  let first = true;
  lines.forEach((line, li) => {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    const cells = raw.split(SEP).map(c => c.trim());
    if (first) {
      first = false;
      const head = cells.map(c => c.toLowerCase());
      if (parseResult(cells[0]).error && head.some(h => /result|value|conc|sample|worker|date|group/.test(h))) {
        cols = head.map(h => /result|value|conc|sample|exposure|twa/.test(h) ? "result" : /worker|employee|person|id/.test(h) ? "worker" : /date|day|time/.test(h) ? "date" : /group|period|phase|before|after|set/.test(h) ? "group" : /note|comment/.test(h) ? "note" : h);
        if (!cols.includes("result")) cols[0] = "result";
        return;
      }
    }
    const rec = { line: li + 1, raw };
    cols.forEach((c, i) => { if (cells[i] !== undefined) rec[c] = cells[i]; });
    const r = parseResult(rec.result ?? cells[0]);
    if (r.error) { errors.push(`Line ${li + 1}: ${r.error}`); return; }
    const dateObj = parseDate(rec.date);
    if (rec.date && !dateObj) errors.push(`Line ${li + 1}: date "${rec.date}" not understood (use YYYY-MM-DD)`);
    rows.push({
      index: rows.length + 1, line: li + 1, raw,
      type: r.type, lo: r.lo, hi: r.hi, value: r.value, censored: r.type !== "exact",
      display: r.type === "exact" ? String(r.value) : r.type === "lt" ? `<${r.hi}` : r.type === "gt" ? `>${r.lo}` : `${r.lo}–${r.hi}`,
      worker: (rec.worker || "").trim() || null,
      date: dateObj, dateText: rec.date || "",
      group: (rec.group || "").trim() || null,
      note: (rec.note || "").trim() || ""
    });
  });
  const workers = [...new Set(rows.map(r => r.worker).filter(Boolean))];
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))];
  return {
    rows, errors, n: rows.length,
    nDetected: rows.filter(r => r.type === "exact").length,
    nCensored: rows.filter(r => r.censored).length,
    nLeft: rows.filter(r => r.type === "lt").length,
    nRight: rows.filter(r => r.type === "gt").length,
    nInterval: rows.filter(r => r.type === "interval").length,
    workers, groups, hasDates: rows.length > 0 && rows.every(r => r.date)
  };
}

// ---------- Substitution and imputation for censored values ----------

function substituted(rows, method) {
  return rows.map(r => {
    if (r.type === "exact") return r.value;
    if (r.type === "lt") return method === "half" ? r.hi / 2 : method === "sqrt2" ? r.hi / Math.SQRT2 : r.hi;
    if (r.type === "gt") return r.lo;
    return Math.sqrt(r.lo * r.hi);
  });
}

/** Negative log-likelihood of log-scale normal(mu, sigma) for censored observations. */
function nllCensored(obs, mu, sigma) {
  let nll = 0;
  for (const o of obs) {
    if (o.type === "exact") {
      const z = (o.lo - mu) / sigma;
      nll += 0.5 * z * z + Math.log(sigma);
    } else if (o.type === "lt") {
      nll -= Math.log(Math.max(pnorm((o.hi - mu) / sigma), 1e-300));
    } else if (o.type === "gt") {
      nll -= Math.log(Math.max(1 - pnorm((o.lo - mu) / sigma), 1e-300));
    } else {
      nll -= Math.log(Math.max(pnorm((o.hi - mu) / sigma) - pnorm((o.lo - mu) / sigma), 1e-300));
    }
  }
  return nll;
}

function logObs(rows, logScale) {
  return rows.map(r => ({
    type: r.type,
    lo: logScale ? (r.lo > 0 ? Math.log(r.lo) : -Infinity) : r.lo,
    hi: logScale ? (Number.isFinite(r.hi) ? Math.log(r.hi) : Infinity) : r.hi
  }));
}

/** Maximum-likelihood normal fit to (possibly censored) observations on the given scale. */
export function fitMLE(rows, { logScale = true } = {}) {
  const obs = logObs(rows, logScale);
  const sub = substituted(rows, "half").map(v => logScale ? Math.log(v) : v);
  const n = sub.length;
  if (n === 0) return null;
  const m0 = mean(sub);
  const s0 = n > 1 ? Math.max(sd(sub), 0.05) : 0.5;
  if (rows.every(r => r.censored) || n < 2) return { mu: m0, sigma: s0, n, converged: false, note: n < 2 ? "one sample: no spread can be estimated" : "all values censored" };
  const f = p => nllCensored(obs, p[0], Math.exp(p[1]));
  const r = nelderMead(f, [m0, Math.log(s0)], { step: 0.3 });
  const r2 = nelderMead(f, r.x, { step: 0.05 });
  return { mu: r2.x[0], sigma: Math.exp(r2.x[1]), n, converged: true, nll: r2.fx };
}

/** Robust regression on order statistics (Helsel) for left-censored data. Returns imputed values. */
export function ros(rows) {
  const dets = rows.filter(r => r.type === "exact").map(r => r.value);
  const nds = rows.filter(r => r.type === "lt").map(r => r.hi);
  if (rows.some(r => r.type === "gt" || r.type === "interval")) return null;
  if (dets.length < 2) return null;
  const dls = [...new Set(nds)].sort((a, b) => a - b);
  const bounds = [0, ...dls, Infinity];
  const m = dls.length;
  // PE_j for j = 0..m (interval j is [bounds[j], bounds[j+1]))
  const A = new Array(m + 1).fill(0), B = new Array(m + 1).fill(0), C = new Array(m + 1).fill(0);
  for (let j = 0; j <= m; j++) {
    A[j] = dets.filter(v => v >= bounds[j] && v < bounds[j + 1]).length;
    B[j] = dets.filter(v => v < bounds[j]).length + nds.filter(v => v <= bounds[j]).length;
    if (j > 0) C[j] = nds.filter(v => v === bounds[j]).length;
  }
  const PE = new Array(m + 2).fill(0);
  for (let j = m; j >= 0; j--) {
    PE[j] = A[j] + B[j] > 0 ? PE[j + 1] + A[j] / (A[j] + B[j]) * (1 - PE[j + 1]) : PE[j + 1];
  }
  PE[0] = 1;
  const detPts = [];
  for (let j = 0; j <= m; j++) {
    const inInt = dets.filter(v => v >= bounds[j] && v < bounds[j + 1]).sort((a, b) => a - b);
    inInt.forEach((v, i) => detPts.push({ v, pp: (1 - PE[j]) + (PE[j] - PE[j + 1]) * (i + 1) / (A[j] + 1) }));
  }
  const cenPts = [];
  for (let j = 1; j <= m; j++) {
    for (let i = 1; i <= C[j]; i++) cenPts.push({ dl: bounds[j], pp: (1 - PE[j]) * i / (C[j] + 1) });
  }
  // regress ln(detect) on normal quantile of pp
  const xs = detPts.map(p => qnorm(p.pp)), ys = detPts.map(p => Math.log(p.v));
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
  const slope = sxx > 0 ? sxy / sxx : 0, intercept = my - slope * mx;
  const imputed = cenPts.map(p => Math.exp(intercept + slope * qnorm(p.pp)));
  const all = [...dets, ...imputed];
  const logs = all.map(Math.log);
  return { values: all, imputed, mu: mean(logs), sigma: logs.length > 1 ? sd(logs) : NaN, slope, intercept, detPts, cenPts };
}

/** Fit the lognormal by the chosen non-detect method. Returns { mu, sigma, n, method, values? }. */
export function fitLognormal(rows, method = "mle") {
  const n = rows.length;
  if (n === 0) return null;
  const anyCensored = rows.some(r => r.censored);
  if (!anyCensored || method === "half" || method === "sqrt2" || method === "dl") {
    const vals = substituted(rows, method);
    const logs = vals.map(Math.log);
    return { mu: mean(logs), sigma: n > 1 ? sd(logs) : NaN, n, method: anyCensored ? method : "none", values: vals, logs };
  }
  if (method === "ros") {
    const r = ros(rows);
    if (r) return { mu: r.mu, sigma: r.sigma, n, method: "ros", values: r.values, logs: r.values.map(Math.log), ros: r };
    // ROS needs ≥ 2 detects and only left-censoring: fall through to MLE
  }
  const m = fitMLE(rows, { logScale: true });
  if (!m) return null;
  return { mu: m.mu, sigma: m.sigma, n, method: method === "ros" ? "mle (ROS not possible)" : "mle", converged: m.converged, note: m.note };
}

// ---------- Descriptive and non-parametric ----------

export function descriptive(rows, values) {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  return {
    n, min: s[0], max: s[n - 1], median: quantile(s, 0.5), p95: quantile(s, 0.95),
    am: mean(s), sdev: n > 1 ? sd(s) : NaN,
    // confidence that the largest value is at least the true 95th percentile: 1 - 0.95^n
    maxCoverage: 1 - Math.pow(0.95, n)
  };
}

/** Clopper-Pearson exact binomial interval. */
function clopperPearson(k, n, alpha = 0.05) {
  const lo = k === 0 ? 0 : bisect(p => binomUpperTail(k, n, p) - alpha / 2, 1e-12, 1 - 1e-12);
  const hi = k === n ? 1 : bisect(p => binomLowerTail(k, n, p) - alpha / 2, 1e-12, 1 - 1e-12);
  return [lo, hi];
}
function binomPmf(k, n, p) {
  let lc = 0;
  for (let i = 1; i <= k; i++) lc += Math.log(n - k + i) - Math.log(i);
  return Math.exp(lc + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
function binomLowerTail(k, n, p) { let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return s; } // P(X <= k)
function binomUpperTail(k, n, p) { let s = 0; for (let i = k; i <= n; i++) s += binomPmf(i, n, p); return s; }  // P(X >= k)

export function nonparametric(rows, oel, al) {
  const vals = substituted(rows, "half");
  const d = descriptive(rows, vals);
  const over = rows.filter(r => r.lo > oel || (r.type === "exact" && r.value > oel)).length;
  const overAl = al ? rows.filter(r => r.lo > al || (r.type === "exact" && r.value > al)).length : null;
  const n = rows.length;
  return {
    ...d,
    over, ef: over / n, efCI: clopperPearson(over, n),
    overAl, efAl: overAl === null ? null : overAl / n,
    // the smallest n at which the sample maximum is a 95/95 upper tolerance limit
    nFor9595: 59
  };
}

// ---------- Frequentist lognormal summary ----------

export function lognormalSummary(fit, oel, al) {
  const { mu, sigma: s, n } = fit;
  if (!(n >= 2) || !(s > 0)) return null;
  const df = n - 1;
  const t975 = qt(0.975, df), t95 = qt(0.95, df);
  const K95 = kFactor(n, 0.95, 0.95);
  const deltaL = Z95 * Math.sqrt(n);
  const Kl = qnt(0.05, df, deltaL) / Math.sqrt(n);
  const lnOel = Math.log(oel);
  const z = (lnOel - mu) / s;
  const ef = 1 - pnorm(z);
  // confidence limits on the exceedance fraction through the noncentral t (see README)
  const tObs = Math.sqrt(n) * z;
  const efUCL = 1 - pnorm(deltaFor(tObs, df, 0.95) / Math.sqrt(n));
  const efLCL = 1 - pnorm(deltaFor(tObs, df, 0.05) / Math.sqrt(n));
  const lnAm = mu + s * s / 2;
  const coxSe = Math.sqrt(s * s / n + Math.pow(s, 4) / (2 * df));
  const out = {
    n, df, mu, sigma: s,
    gm: Math.exp(mu), gsd: Math.exp(s),
    gmCI: [Math.exp(mu - t975 * s / Math.sqrt(n)), Math.exp(mu + t975 * s / Math.sqrt(n))],
    gsdCI: [Math.exp(s * Math.sqrt(df / qchisq(0.975, df))), Math.exp(s * Math.sqrt(df / qchisq(0.025, df)))],
    am: Math.exp(lnAm),
    amUCL: Math.exp(lnAm + t95 * coxSe),
    amLCL: Math.exp(lnAm - t95 * coxSe),
    amCI95: [Math.exp(lnAm - t975 * coxSe), Math.exp(lnAm + t975 * coxSe)],
    x95: Math.exp(mu + Z95 * s),
    K95, x95UCL: Math.exp(mu + K95 * s), x95LCL: Math.exp(mu + Kl * s),
    ef, efUCL, efLCL,
    efAl: al ? 1 - pnorm((Math.log(al) - mu) / s) : null,
    x95RatioOel: Math.exp(mu + Z95 * s) / oel,
    x95UclRatioOel: Math.exp(mu + K95 * s) / oel,
    x95LclRatioOel: Math.exp(mu + Kl * s) / oel
  };
  out.band = bandOf(out.x95RatioOel);
  out.bandUCL = bandOf(out.x95UclRatioOel);
  // fraction of exposures above the action level and the AL verdicts
  if (al) { out.x95RatioAl = out.x95 / al; out.x95UclRatioAl = out.x95UCL / al; }
  return out;
}

/** Noncentrality delta such that P(T_{df, delta} <= tObs) = conf. */
function deltaFor(tObs, df, conf) {
  const f = d => pnt(tObs, df, d) - conf;
  let lo = -60, hi = 60;
  if (f(lo) < 0) return lo; // (practically impossible)
  if (f(hi) > 0) return hi;
  return bisect(f, lo, hi, 1e-9);
}

// ---------- Normal (arithmetic) fit for the normal vs lognormal choice ----------

export function normalSummary(rows, oel) {
  const m = fitMLE(rows, { logScale: false });
  if (!m || !(m.n >= 2)) return null;
  const n = m.n, df = n - 1;
  const K95 = kFactor(n);
  return {
    n, mean: m.mu, sdev: m.sigma, x95: m.mu + Z95 * m.sigma, x95UCL: m.mu + K95 * m.sigma,
    ef: 1 - pnorm((oel - m.mu) / m.sigma)
  };
}

// ---------- Goodness of fit ----------

export function goodnessOfFit(rows, fit) {
  const exact = rows.filter(r => r.type === "exact").map(r => r.value);
  const useVals = fit.values ? fit.values : exact; // substituted / ROS values when available, else detects only
  const out = { n: useVals.length, note: "" };
  if (rows.some(r => r.censored) && !fit.values) out.note = "Shapiro-Wilk on the detected values only (the MLE fit uses the censored values through the likelihood).";
  if (useVals.length >= 3 && new Set(useVals).size > 1) {
    out.lognormal = shapiroWilk(useVals.map(Math.log));
    out.normal = shapiroWilk(useVals);
    out.preferred = out.lognormal.W >= out.normal.W ? "lognormal" : "normal";
    out.lognormalOk = out.lognormal.p >= 0.05;
    out.normalOk = out.normal.p >= 0.05;
  } else {
    out.preferred = "lognormal";
    out.note = useVals.length < 3 ? "At least three distinct values are needed for a goodness-of-fit test." : out.note;
  }
  // Q-Q plot points (log scale), Blom plotting positions, censored values shown at their bound
  const all = rows.map(r => ({ v: r.type === "exact" ? r.value : r.type === "lt" ? r.hi : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi), censored: r.censored, type: r.type }))
    .sort((a, b) => a.v - b.v);
  const n = all.length;
  out.qq = all.map((p, i) => ({ x: qnorm((i + 1 - 0.375) / (n + 0.25)), y: Math.log(p.v), v: p.v, censored: p.censored, type: p.type }));
  if (out.qq.length >= 2) {
    const xs = out.qq.map(p => p.x), ys = out.qq.map(p => p.y);
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    out.filliben = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN; // probability plot correlation coefficient
  }
  return out;
}

// ---------- Bayesian lognormal (Gibbs sampler with data augmentation for censored values) ----------

/**
 * Posterior draws of (mu, sigma) for log-scale normal data with censoring.
 * Priors: mu flat; sigma uniform on (0, sigmaMax) (Expostats' choice), or, for the single-sample /
 * informative case, ln(sigma) ~ Normal(ln(ln gsdMedian), spread) sampled by a Metropolis step.
 */
export function bayesLognormal(rows, opts = {}) {
  const o = { ...DEFAULTS.bayes, ...opts };
  const obs = logObs(rows, true);
  const n = obs.length;
  if (n === 0) return null;
  const rng = new Rng(o.seed);
  const informative = o.informative || n < 2;
  const priorMuLnSigma = Math.log(Math.log(o.singleGsd || 2.5));
  const priorSdLnSigma = o.singleGsdSpread || 0.5;
  // starting values from substitution
  const y = rows.map(r => Math.log(r.type === "exact" ? r.value : r.type === "lt" ? r.hi / 2 : r.type === "gt" ? r.lo * 1.5 : Math.sqrt(r.lo * r.hi)));
  let mu = mean(y);
  let sigma = n > 1 ? Math.max(sd(y), 0.1) : Math.log(o.singleGsd || 2.5);
  const total = o.burn + o.draws;
  const mus = new Float64Array(o.draws), sigmas = new Float64Array(o.draws);
  let accepted = 0;
  for (let it = 0; it < total; it++) {
    // censored values
    for (let i = 0; i < n; i++) {
      const ob = obs[i];
      if (ob.type === "exact") { y[i] = ob.lo; continue; }
      y[i] = rng.truncNormal(mu, sigma, ob.lo, ob.hi);
    }
    // mu | sigma, y
    const ybar = mean(y);
    mu = ybar + rng.normal() * sigma / Math.sqrt(n);
    // sigma | mu, y
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (y[i] - mu) ** 2;
    if (!informative) {
      // p(sigma) uniform  =>  sigma^2 | . ~ Inv-Gamma((n-1)/2, ss/2), truncated at sigmaMax
      sigma = drawSigma(rng, (n - 1) / 2, ss / 2, o.sigmaMax, sigma);
    } else {
      // Metropolis random walk on ln(sigma) with the lognormal prior
      const logPost = s => -n * Math.log(s) - ss / (2 * s * s) - 0.5 * ((Math.log(s) - priorMuLnSigma) / priorSdLnSigma) ** 2;
      const prop = Math.exp(Math.log(sigma) + rng.normal() * 0.4);
      if (Math.log(rng.uniform()) < logPost(prop) - logPost(sigma) + Math.log(prop) - Math.log(sigma)) { sigma = prop; accepted++; }
    }
    if (it >= o.burn) { mus[it - o.burn] = mu; sigmas[it - o.burn] = sigma; }
  }
  return { mus, sigmas, draws: o.draws, informative, acceptance: informative ? accepted / total : null, seed: o.seed };
}

/** Draw sigma from sigma^2 ~ Inv-Gamma(shape, scale) truncated to (0, sigmaMax) by rejection. */
function drawSigma(rng, shape, scale, sigmaMax, current) {
  for (let tries = 0; tries < 100; tries++) {
    const s = Math.sqrt(scale / rng.gamma(shape));
    if (s < sigmaMax) return s;
  }
  return Math.min(current, sigmaMax * 0.999);
}

function summarise(arr, probs = [0.05, 0.5, 0.95]) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return { lo: quantile(s, probs[0]), median: quantile(s, probs[1]), hi: quantile(s, probs[2]), mean: mean(s) };
}

/** Derived posterior summaries for the exposure metrics, with AIHA band probabilities. */
export function bayesSummary(post, oel, al, decision = DEFAULTS.decision) {
  if (!post) return null;
  const { mus, sigmas, draws } = post;
  const gm = new Float64Array(draws), gsd = new Float64Array(draws), x95 = new Float64Array(draws), am = new Float64Array(draws), ef = new Float64Array(draws);
  const lnOel = Math.log(oel), lnAl = al ? Math.log(al) : null;
  const bandCount = [0, 0, 0, 0];
  let overOel = 0, overAl = 0, ef5 = 0, amOver = 0;
  const bandIdx = new Uint8Array(draws);
  for (let i = 0; i < draws; i++) {
    const m = mus[i], s = sigmas[i];
    gm[i] = Math.exp(m); gsd[i] = Math.exp(s);
    x95[i] = Math.exp(m + Z95 * s);
    am[i] = Math.exp(m + s * s / 2);
    ef[i] = 1 - pnorm((lnOel - m) / s);
    const ratio = x95[i] / oel;
    const b = ratio < 0.1 ? 0 : ratio < 0.5 ? 1 : ratio < 1 ? 2 : 3;
    bandIdx[i] = b; bandCount[b]++;
    if (ratio > 1) overOel++;
    if (lnAl !== null && x95[i] > al) overAl++;
    if (ef[i] > 0.05) ef5++;
    if (am[i] > oel) amOver++;
  }
  let bandProbs = bandCount.map(c => c / draws);
  let bandProbsPrior = null, pOverOelPrior = null;
  if (decision.usePrior && decision.prior) {
    // decision prior over the four AIHA categories relative to equal belief (IHSTAT-Bayes style reweighting)
    const w = decision.prior.map(p => p / 0.25);
    const tot = bandProbs.reduce((s, p, k) => s + p * w[k], 0);
    bandProbsPrior = bandProbs.map((p, k) => p * w[k] / tot);
    pOverOelPrior = bandProbsPrior[3];
  }
  return {
    draws,
    gm: summarise(gm), gsd: summarise(gsd), x95: summarise(x95), am: summarise(am), ef: summarise(ef),
    pOverOel: overOel / draws,          // P(95th percentile > OEL) = P(exceedance fraction > 5%)
    pOverAl: al ? overAl / draws : null,
    pEf5: ef5 / draws,
    pAmOverOel: amOver / draws,
    bandProbs, bandProbsPrior, pOverOelPrior,
    x95Ratio: summarise(x95.map(v => v / oel)),
    informative: post.informative
  };
}

// ---------- Between-worker / within-worker ----------

export function workerAnalysis(rows, fit, oel, bayesOpts = {}) {
  const byW = new Map();
  rows.forEach((r, i) => { if (r.worker) { if (!byW.has(r.worker)) byW.set(r.worker, []); byW.get(r.worker).push(i); } });
  const k = byW.size;
  if (k < 2) return null;
  const vals = fit.values ? fit.values.map(Math.log) : substituted(rows, "half").map(Math.log);
  const N = vals.length;
  const groups = [...byW.entries()].map(([w, idx]) => ({ worker: w, idx, n: idx.length, logs: idx.map(i => vals[i]) }));
  const withRepeats = groups.filter(g => g.n >= 2).length;
  // One-way random effects ANOVA (unbalanced) on the log values
  const grand = mean(vals);
  let ssb = 0, ssw = 0, sumn2 = 0;
  for (const g of groups) {
    const gm = mean(g.logs);
    ssb += g.n * (gm - grand) ** 2;
    for (const v of g.logs) ssw += (v - gm) ** 2;
    sumn2 += g.n * g.n;
  }
  const dfb = k - 1, dfw = N - k;
  const msb = ssb / dfb, msw = dfw > 0 ? ssw / dfw : NaN;
  const n0 = (N - sumn2 / N) / dfb;
  const sigmaW2 = msw, sigmaB2 = Math.max(0, (msb - msw) / n0);
  const sigmaW = Math.sqrt(sigmaW2), sigmaB = Math.sqrt(sigmaB2);
  const anova = {
    k, N, withRepeats, n0, msb, msw, dfb, dfw,
    sigmaB, sigmaW, gsdB: Math.exp(sigmaB), gsdW: Math.exp(sigmaW),
    R: Math.exp(2 * 1.959964 * sigmaB), // ratio of the 97.5th to the 2.5th percentile of worker mean exposures
    fracBetween: sigmaB2 + sigmaW2 > 0 ? sigmaB2 / (sigmaB2 + sigmaW2) : NaN,
    F: Number.isFinite(msw) && msw > 0 ? msb / msw : NaN
  };
  anova.pF = Number.isFinite(anova.F) ? 1 - pf(anova.F, dfb, dfw) : NaN;
  // Probability that a random worker's own 95th percentile exceeds the OEL (point estimate)
  const lnOel = Math.log(oel);
  anova.pWorkerX95Over = sigmaB > 0 ? 1 - pnorm((lnOel - fit.mu - Z95 * sigmaW) / sigmaB) : (fit.mu + Z95 * sigmaW > lnOel ? 1 : 0);
  // Rappaport's theta: probability that a random worker's mean exposure exceeds the OEL
  anova.theta = sigmaB > 0 ? 1 - pnorm((lnOel - fit.mu - sigmaW2 / 2) / sigmaB) : (fit.mu + sigmaW2 / 2 > lnOel ? 1 : 0);
  anova.workers = groups.map(g => ({ worker: g.worker, n: g.n, gm: Math.exp(mean(g.logs)), max: Math.exp(Math.max(...g.logs)), min: Math.exp(Math.min(...g.logs)) }));

  // Bayesian random-effects model by Gibbs sampling (data augmentation for censored values)
  const bayes = bayesWorker(rows, groups, oel, bayesOpts);
  return { anova, bayes, groups: anova.workers };
}

function bayesWorker(rows, groups, oel, opts) {
  const o = { ...DEFAULTS.bayes, ...opts, draws: Math.min(opts.draws || DEFAULTS.bayes.draws, 6000) };
  const rng = new Rng(o.seed + 7);
  const obs = logObs(rows, true);
  const N = rows.length, k = groups.length;
  if (k < 2 || N - k < 1) return null;
  const wIdx = new Int32Array(N);
  groups.forEach((g, gi) => g.idx.forEach(i => { wIdx[i] = gi; }));
  const y = rows.map(r => Math.log(r.type === "exact" ? r.value : r.type === "lt" ? r.hi / 2 : r.type === "gt" ? r.lo * 1.5 : Math.sqrt(r.lo * r.hi)));
  let mu = mean(y), sigmaW = Math.max(0.2, sd(y) * 0.7), sigmaB = Math.max(0.2, sd(y) * 0.7);
  const b = new Float64Array(k);
  const total = o.burn + o.draws;
  const out = { mu: new Float64Array(o.draws), sigmaB: new Float64Array(o.draws), sigmaW: new Float64Array(o.draws) };
  const lnOel = Math.log(oel);
  let pX95 = 0, pTheta = 0;
  const pX95Arr = new Float64Array(o.draws), RArr = new Float64Array(o.draws);
  for (let it = 0; it < total; it++) {
    // censored values
    for (let i = 0; i < N; i++) {
      const ob = obs[i];
      if (ob.type === "exact") { y[i] = ob.lo; continue; }
      y[i] = rng.truncNormal(mu + b[wIdx[i]], sigmaW, ob.lo, ob.hi);
    }
    // worker effects
    for (let gi = 0; gi < k; gi++) {
      const g = groups[gi];
      let s = 0;
      for (const i of g.idx) s += y[i] - mu;
      const prec = g.n / (sigmaW * sigmaW) + 1 / (sigmaB * sigmaB);
      const m = (s / (sigmaW * sigmaW)) / prec;
      b[gi] = m + rng.normal() / Math.sqrt(prec);
    }
    // mu
    let s = 0;
    for (let i = 0; i < N; i++) s += y[i] - b[wIdx[i]];
    mu = s / N + rng.normal() * sigmaW / Math.sqrt(N);
    // sigmaW (uniform prior on sigma => Inv-Gamma((N-1)/2, SSE/2))
    let sse = 0;
    for (let i = 0; i < N; i++) sse += (y[i] - mu - b[wIdx[i]]) ** 2;
    sigmaW = drawSigma(rng, (N - 1) / 2, sse / 2, o.sigmaMax, sigmaW);
    // sigmaB (uniform prior on sigma => Inv-Gamma((k-1)/2, sum b^2 / 2))
    let ssb = 0;
    for (let gi = 0; gi < k; gi++) ssb += b[gi] * b[gi];
    sigmaB = Math.max(drawSigma(rng, (k - 1) / 2, ssb / 2, o.sigmaMax, sigmaB), 1e-4);
    if (it >= o.burn) {
      const j = it - o.burn;
      out.mu[j] = mu; out.sigmaB[j] = sigmaB; out.sigmaW[j] = sigmaW;
      const p = 1 - pnorm((lnOel - mu - Z95 * sigmaW) / sigmaB);
      pX95Arr[j] = p; pX95 += p;
      pTheta += 1 - pnorm((lnOel - mu - sigmaW * sigmaW / 2) / sigmaB);
      RArr[j] = Math.exp(2 * 1.959964 * sigmaB);
    }
  }
  return {
    draws: o.draws,
    gsdB: summarise(out.sigmaB.map(Math.exp)), gsdW: summarise(out.sigmaW.map(Math.exp)),
    R: summarise(RArr),
    pWorkerX95Over: pX95 / o.draws,           // probability a random worker's 95th percentile exceeds the OEL
    pWorkerX95OverCI: summarise(pX95Arr),
    theta: pTheta / o.draws,                  // probability a random worker's mean exposure exceeds the OEL
    pRabove2: Array.from(RArr).filter(v => v > 2).length / o.draws
  };
}

// ---------- Group comparison (before / after, group to group) ----------

export function compareGroups(rows, names, oel, al, ndMethod, bayesOpts, decision) {
  const [ga, gb] = names;
  const A = rows.filter(r => r.group === ga), B = rows.filter(r => r.group === gb);
  if (A.length < 2 || B.length < 2) return { names, error: "each group needs at least two samples" };
  const fa = fitLognormal(A, ndMethod), fb = fitLognormal(B, ndMethod);
  const sa = lognormalSummary(fa, oel, al), sb = lognormalSummary(fb, oel, al);
  if (!sa || !sb) return { names, error: "the groups need some spread in their values" };
  // Welch t-test on the log values (ratio of geometric means)
  const na = fa.n, nb = fb.n, va = fa.sigma ** 2 / na, vb = fb.sigma ** 2 / nb;
  const se = Math.sqrt(va + vb);
  const t = (fb.mu - fa.mu) / se;
  const dfW = (va + vb) ** 2 / (va * va / (na - 1) + vb * vb / (nb - 1));
  const pTwo = 2 * (1 - pt(Math.abs(t), dfW));
  const tcrit = qt(0.975, dfW);
  const gmRatio = Math.exp(fb.mu - fa.mu);
  const gmRatioCI = [Math.exp(fb.mu - fa.mu - tcrit * se), Math.exp(fb.mu - fa.mu + tcrit * se)];
  // F-test for the GSDs
  const F = (fb.sigma / fa.sigma) ** 2;
  const pF = 2 * Math.min(pf(F, nb - 1, na - 1), 1 - pf(F, nb - 1, na - 1));
  // Bayesian: independent posteriors, compare draw by draw
  const pa = bayesLognormal(A, { ...bayesOpts, seed: (bayesOpts.seed || DEFAULTS.bayes.seed) + 11 });
  const pb = bayesLognormal(B, { ...bayesOpts, seed: (bayesOpts.seed || DEFAULTS.bayes.seed) + 23 });
  const ba = bayesSummary(pa, oel, al, decision), bb = bayesSummary(pb, oel, al, decision);
  const d = Math.min(pa.draws, pb.draws);
  let gmLower = 0, x95Lower = 0, amLower = 0;
  const x95RatioArr = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    if (pb.mus[i] < pa.mus[i]) gmLower++;
    const xa = pa.mus[i] + Z95 * pa.sigmas[i], xb = pb.mus[i] + Z95 * pb.sigmas[i];
    if (xb < xa) x95Lower++;
    if (pb.mus[i] + pb.sigmas[i] ** 2 / 2 < pa.mus[i] + pa.sigmas[i] ** 2 / 2) amLower++;
    x95RatioArr[i] = Math.exp(xb - xa);
  }
  return {
    names, A: { n: na, fit: fa, summary: sa, bayes: ba }, B: { n: nb, fit: fb, summary: sb, bayes: bb },
    gmRatio, gmRatioCI, t, dfW, pTwo, F, pF,
    bayes: { pGmBLower: gmLower / d, pX95BLower: x95Lower / d, pAmBLower: amLower / d, x95Ratio: summarise(x95RatioArr) }
  };
}

// ---------- Sampling and analytical error ----------

export function saeAnalysis(rows, saeIn, oel) {
  const s = { ...DEFAULTS.sae, ...saeIn };
  let sae, cvTotal = null;
  if (s.mode === "direct") { sae = (Number(s.saePct) || 0) / 100; }
  else {
    cvTotal = Math.sqrt((Number(s.cvAnalytical) || 0) ** 2 + (Number(s.cvSampling) || 0) ** 2);
    sae = Z95 * cvTotal;
  }
  const perSample = rows.map(r => {
    const x = r.type === "exact" ? r.value : r.type === "lt" ? r.hi : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi);
    const y = x / oel;
    const lcl = y * (1 - sae), ucl = y * (1 + sae);
    let cls, text;
    if (r.type === "lt") { cls = ucl < 1 ? "compliant" : "possible"; text = ucl < 1 ? "Below the OEL (non-detect)" : "Non-detect, but the detection limit is close to the OEL"; }
    else if (lcl > 1) { cls = "over"; text = "Overexposure: the lower confidence limit is above the OEL"; }
    else if (ucl < 1) { cls = "compliant"; text = "Below the OEL with 95% confidence"; }
    else { cls = "possible"; text = "Possible overexposure: the confidence limits straddle the OEL"; }
    return { index: r.index, display: r.display, x, y, lcl, ucl, cls, text };
  });
  const counts = { compliant: perSample.filter(p => p.cls === "compliant").length, possible: perSample.filter(p => p.cls === "possible").length, over: perSample.filter(p => p.cls === "over").length };
  return { sae, saePct: sae * 100, cvTotal, mode: s.mode, perSample, counts };
}

// ---------- Data-quality gatekeeper ----------

const GATE_QUESTIONS = [
  { key: "sameTask", q: "Same task, process and materials for every sample" },
  { key: "sameControls", q: "Same engineering and administrative controls in place for every sample" },
  { key: "sameRate", q: "Similar production rate, workload or throughput" },
  { key: "sameMethod", q: "Same sampling and analytical method (and the same laboratory)" },
  { key: "sameDuration", q: "Comparable sample durations (all full-shift TWAs, or all the same task period)" },
  { key: "spread", q: "Samples spread over different days and shifts (not all from one day)" },
  { key: "noChange", q: "No process, control or product change within the sampling period" }
];
export { GATE_QUESTIONS };

function grubbs(logs) {
  const n = logs.length;
  if (n < 4) return null;
  const m = mean(logs), s = sd(logs);
  if (!(s > 0)) return null;
  let gi = 0, g = 0;
  logs.forEach((v, i) => { const d = Math.abs(v - m) / s; if (d > g) { g = d; gi = i; } });
  const tc = qt(1 - 0.05 / (2 * n), n - 2);
  const gcrit = (n - 1) / Math.sqrt(n) * Math.sqrt(tc * tc / (n - 2 + tc * tc));
  return { G: g, gcrit, index: gi, outlier: g > gcrit };
}

function spearman(x, y) {
  const n = x.length;
  if (n < 4) return null;
  const rx = ranks(x), ry = ranks(y);
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  if (!(sxx > 0 && syy > 0)) return null;
  const rho = sxy / Math.sqrt(sxx * syy);
  const t = rho * Math.sqrt((n - 2) / Math.max(1 - rho * rho, 1e-12));
  const p = 2 * (1 - pt(Math.abs(t), n - 2));
  return { rho, p };
}

export function gatekeeper(data, gateIn, override) {
  const g = { ...DEFAULTS.gate, ...gateIn };
  const items = [];
  const rows = data.rows;
  // Questions
  for (const q of GATE_QUESTIONS) {
    const a = g[q.key];
    if (a === "no") items.push({ key: q.key, level: "fail", text: `${q.q}: No. These samples describe more than one exposure situation and should not be pooled into one SEG.` });
    else if (a === "unknown") items.push({ key: q.key, level: "warn", text: `${q.q}: Unknown. Confirm before relying on the pooled statistics.` });
    else items.push({ key: q.key, level: "ok", text: `${q.q}: Yes.` });
  }
  // Sample size
  if (data.n === 0) items.push({ key: "n", level: "fail", text: "No samples entered." });
  else if (data.n === 1) items.push({ key: "n", level: "warn", text: "One sample: the spread of exposures cannot be estimated from the data. The tool uses an assumed GSD (set below) and the sample's own confidence limits." });
  else if (data.n < 3) items.push({ key: "n", level: "warn", text: `${data.n} samples: estimates are very uncertain; no goodness-of-fit test is possible.` });
  else if (data.n < 6) items.push({ key: "n", level: "warn", text: `${data.n} samples: usable, but the 95th-percentile upper limit will be wide. AIHA suggests 6 to 10 samples per SEG.` });
  else items.push({ key: "n", level: "ok", text: `${data.n} samples.` });
  // Censoring
  if (data.n > 0) {
    const fc = data.nCensored / data.n;
    if (data.nDetected === 0) items.push({ key: "nd", level: "warn", text: "Every result is censored (non-detect or range). Only bounds and a non-parametric view are meaningful." });
    else if (fc > 0.8) items.push({ key: "nd", level: "warn", text: `${Math.round(fc * 100)}% of results are censored: the lognormal fit rests on ${data.nDetected} detected value(s).` });
    else if (fc > 0.5) items.push({ key: "nd", level: "warn", text: `${Math.round(fc * 100)}% of results are censored (non-detects). Use MLE or ROS, not substitution.` });
    else if (data.nCensored > 0) items.push({ key: "nd", level: "ok", text: `${data.nCensored} censored result(s) handled by the chosen non-detect method.` });
  }
  // Dates: span and trend
  if (data.hasDates && data.n >= 2) {
    const times = rows.map(r => r.date.getTime());
    const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
    const perYear = data.n / Math.max(spanDays / 365.25, 1 / 365.25);
    if (spanDays > 730 && data.n < 6) items.push({ key: "span", level: "fail", text: `${data.n} samples spread over ${(spanDays / 365.25).toFixed(1)} years (about ${perYear.toFixed(1)} per year). Conditions almost certainly changed across that period; these cannot be pooled as one SEG without evidence that nothing changed.` });
    else if (spanDays > 365 * 3) items.push({ key: "span", level: "warn", text: `Samples span ${(spanDays / 365.25).toFixed(1)} years. Check that the process and controls were unchanged throughout.` });
    else items.push({ key: "span", level: "ok", text: spanDays < 1 ? "All samples from one day." : `Samples span ${Math.round(spanDays)} days.` });
    const distinctDays = new Set(rows.map(r => r.date.toISOString().slice(0, 10))).size;
    if (data.n >= 3 && distinctDays === 1) items.push({ key: "days", level: "warn", text: "All samples were collected on one day: day-to-day variability is not represented." });
    const vals = rows.map(r => r.type === "exact" ? r.value : r.type === "lt" ? r.hi / 2 : r.type === "gt" ? r.lo : Math.sqrt(r.lo * r.hi));
    const sp = spearman(times, vals);
    if (sp && sp.p < 0.05) items.push({ key: "trend", level: "warn", text: `Exposures ${sp.rho > 0 ? "rise" : "fall"} over time (Spearman rho = ${sp.rho.toFixed(2)}, p = ${sp.p.toFixed(3)}). A trend means the SEG is not stable; the later samples may describe a different situation.`, stat: sp });
    else if (sp) items.push({ key: "trend", level: "ok", text: `No time trend detected (Spearman rho = ${sp.rho.toFixed(2)}, p = ${sp.p.toFixed(2)}).`, stat: sp });
  } else if (data.n >= 2 && rows.some(r => r.date)) {
    items.push({ key: "span", level: "warn", text: "Some samples have no date, so the time span and trend checks were skipped." });
  }
  // Outlier (on the log scale)
  const logs = rows.filter(r => r.type === "exact").map(r => Math.log(r.value));
  const gr = grubbs(logs);
  if (gr && gr.outlier) {
    const v = Math.exp(logs[gr.index]);
    items.push({ key: "outlier", level: "warn", text: `One result (${v}) is an outlier on the log scale (Grubbs G = ${gr.G.toFixed(2)} > ${gr.gcrit.toFixed(2)}). Check it: a transcription error, a different task, or a real upset condition?`, stat: gr });
  } else if (gr) items.push({ key: "outlier", level: "ok", text: "No outlier on the log scale (Grubbs' test)." });
  // Workers
  if (data.workers.length >= 2) {
    const byW = new Map();
    rows.forEach(r => { if (r.worker) byW.set(r.worker, (byW.get(r.worker) || 0) + 1); });
    const repeats = [...byW.values()].filter(n => n >= 2).length;
    if (repeats === 0) items.push({ key: "workers", level: "ok", text: `${data.workers.length} workers, one sample each: between-worker variance cannot be separated from day-to-day variance.` });
    else items.push({ key: "workers", level: "ok", text: `${data.workers.length} workers (${repeats} with repeat samples): between- and within-worker variance can be estimated. A between-worker ratio R above 10 would suggest the SEG is not homogeneous.` });
  } else if (data.n >= 3) items.push({ key: "workers", level: "ok", text: "No worker IDs (or one worker): worker-to-worker differences are not checked." });

  if (data.analyzedGroup) items.push({ key: "group", level: "ok", text: `Analysing the "${data.analyzedGroup}" group only (${data.n} of ${data.subsetOf} samples); the comparison in 09 still uses every group.` });
  else if (data.groups.length >= 2 && data.n >= 2) items.push({ key: "group", level: "warn", text: `The samples carry ${data.groups.length} group labels (${data.groups.join(", ")}) and are pooled. If the groups describe different conditions (before / after a change), choose one group to analyse under 02 and read the change in 09 Comparison.` });
  const fails = items.filter(i => i.level === "fail"), warns = items.filter(i => i.level === "warn");
  let status = fails.length ? "fail" : warns.length ? "caution" : "pass";
  if (data.n === 0) status = "none";
  const allowed = status === "pass" || status === "caution" || (status === "fail" && !!override);
  return { status, items, fails, warns, allowed, overridden: status === "fail" && !!override };
}

// ---------- Verdict ----------

export function verdict(ctx) {
  const { gate, data, summary, bayes, np, oel, al, decision, sae, single } = ctx;
  const go = decision.goThreshold, nogo = decision.nogoThreshold;
  const r = { status: "none", title: "No result yet", reasons: [], band: null, marker: null, alText: "" };
  if (!gate.allowed) {
    r.status = "withheld"; r.title = gate.status === "none" ? "Enter sample results to begin" : "Statistics withheld: data-quality check failed";
    r.reasons = gate.fails.map(f => f.text);
    return r;
  }
  if (single) {
    // One sample: the SAE compliance call plus the assumed-GSD Bayesian view
    const s = sae.perSample[0];
    r.marker = s.y; r.band = bandOf(s.y);
    r.reasons.push(`One sample at ${fmt(s.x)} = ${pct(s.y)} of the OEL. With a sampling and analytical error of ±${sae.saePct.toFixed(0)}%, its 95% confidence limits are ${pct(s.lcl)} to ${pct(s.ucl)} of the OEL.`);
    if (bayes) {
      r.pOver = bayes.pOverOel;
      r.reasons.push(`Assuming a GSD of about ${ctx.singleGsd} (typical for a well-defined SEG), the probability that the SEG's 95th percentile exceeds the OEL is ${pct(bayes.pOverOel)}.`);
    }
    if (s.cls === "over") { r.status = "nogo"; r.title = "No-go: this sample shows an overexposure"; }
    else if (bayes && bayes.pOverOel < go) { r.status = "go"; r.title = "Go, provisionally: one sample is well below the OEL"; r.reasons.push("One sample cannot characterise the SEG. Collect more before treating this as compliant."); }
    else { r.status = "more"; r.title = "Needs more data: one sample cannot characterise the exposure"; }
    return r;
  }
  if (!summary) {
    r.status = "more"; r.title = "Needs more data";
    r.reasons.push("The lognormal fit could not be made (no spread in the values, or every value censored).");
    if (np) r.reasons.push(`Non-parametric view: ${np.over} of ${np.n} results exceed the OEL; the largest result is ${fmt(np.max)}.`);
    return r;
  }
  const p = bayes ? (decision.usePrior && bayes.pOverOelPrior !== null ? bayes.pOverOelPrior : bayes.pOverOel) : null;
  r.pOver = p;
  r.marker = summary.x95RatioOel; r.band = summary.band;
  r.lo = summary.x95LclRatioOel; r.hi = summary.x95UclRatioOel;
  r.reasons.push(`The 95th percentile of exposures is estimated at ${fmt(summary.x95)} ${ctx.unit}, ${pct(summary.x95RatioOel)} of the OEL (AIHA ${summary.band.name}, ${summary.band.label}: ${summary.band.text.toLowerCase()}).`);
  r.reasons.push(`Its 95% upper confidence limit (UTL95,95) is ${fmt(summary.x95UCL)} ${ctx.unit}, ${pct(summary.x95UclRatioOel)} of the OEL. ${summary.x95UclRatioOel < 1 ? "So there is 95% confidence that fewer than 5% of exposures exceed the OEL." : "So the data cannot rule out more than 5% of exposures above the OEL."}`);
  if (p !== null) r.reasons.push(`Bayesian overexposure risk: ${pct(p)} probability that the 95th percentile exceeds the OEL (that more than 5% of exposures exceed it)${decision.usePrior ? ", with the decision prior applied" : ""}.`);
  r.reasons.push(`Estimated exceedance fraction ${pct(summary.ef)} (95% UCL ${pct(summary.efUCL)}).`);
  if (p !== null) {
    if (p < go) { r.status = "go"; r.title = "Go: exposures are acceptably controlled"; }
    else if (p >= nogo || summary.x95RatioOel >= 1) { r.status = "nogo"; r.title = summary.x95RatioOel >= 1 ? "No-go: the 95th percentile exceeds the OEL" : "No-go: the overexposure risk is too high"; }
    else { r.status = "more"; r.title = "Gray zone: needs more data or more control"; }
  } else {
    if (summary.x95UclRatioOel < 1) { r.status = "go"; r.title = "Go: exposures are acceptably controlled"; }
    else if (summary.x95RatioOel >= 1) { r.status = "nogo"; r.title = "No-go: the 95th percentile exceeds the OEL"; }
    else { r.status = "more"; r.title = "Gray zone: needs more data or more control"; }
  }
  if (r.status === "go") r.reasons.push(`The overexposure risk is below the ${pct(go)} "go" threshold.`);
  if (r.status === "more") r.reasons.push(`The point estimate is below the OEL but the overexposure risk (${pct(p)}) is between the ${pct(go)} go threshold and the ${pct(nogo)} no-go threshold. More samples would narrow the confidence limits; otherwise treat the exposure as uncontrolled and act on it.`);
  if (r.status === "nogo" && p !== null && summary.x95RatioOel < 1) r.reasons.push(`The overexposure risk (${pct(p)}) is at or above the ${pct(nogo)} no-go threshold.`);
  // sample-level SAE view
  if (sae && sae.counts.over > 0) r.reasons.push(`${sae.counts.over} individual sample(s) show an overexposure on their own (lower confidence limit above the OEL).`);
  // action level
  if (al) {
    if (summary.x95UclRatioAl < 1) r.alText = `Below the action level (${fmt(al)} ${ctx.unit}) with 95% confidence: the 95th percentile's upper limit is ${pct(summary.x95UclRatioAl)} of the action level.`;
    else if (summary.x95RatioAl < 1) r.alText = `The 95th percentile (${pct(summary.x95RatioAl)} of the action level) is below the action level, but its upper limit is not: exposures above the action level cannot be ruled out.`;
    else r.alText = `Above the action level: the 95th percentile is ${pct(summary.x95RatioAl)} of the action level (${fmt(al)} ${ctx.unit}). Periodic monitoring, training and medical surveillance provisions that key off the action level apply.`;
    if (bayes && bayes.pOverAl !== null) r.alText += ` Probability that the 95th percentile exceeds the action level: ${pct(bayes.pOverAl)}.`;
  }
  return r;
}

export function fmt(v, digits) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
  const a = Math.abs(v);
  if (digits !== undefined) return v.toFixed(digits);
  if (a === 0) return "0";
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(2);
}
export function pct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return v > 0 ? ">1000%" : "0%";
  const p = v * 100;
  if (p >= 1000) return ">1000%";
  if (p >= 100) return p.toFixed(0) + "%";
  if (p >= 10) return p.toFixed(0) + "%";
  if (p >= 1) return p.toFixed(1) + "%";
  if (p >= 0.1) return p.toFixed(2) + "%";
  if (p === 0) return "0%";
  return "<0.1%";
}

// ---------- The whole analysis ----------

/** The subset of parsed data for one group label (keeps the original sample numbers). */
export function subsetData(data, group) {
  if (!group || !data.groups.includes(group)) return data;
  const rows = data.rows.filter(r => r.group === group);
  return {
    ...data, rows, n: rows.length, subsetOf: data.n, analyzedGroup: group,
    nDetected: rows.filter(r => r.type === "exact").length,
    nCensored: rows.filter(r => r.censored).length,
    nLeft: rows.filter(r => r.type === "lt").length,
    nRight: rows.filter(r => r.type === "gt").length,
    nInterval: rows.filter(r => r.type === "interval").length,
    workers: [...new Set(rows.map(r => r.worker).filter(Boolean))],
    hasDates: rows.length > 0 && rows.every(r => r.date)
  };
}

export function analyze(inputsIn) {
  const inputs = mergeDefaults(inputsIn);
  const allData = parseSamples(inputs.samplesText);
  const data = subsetData(allData, inputs.analyzeGroup);
  const oel = Number(inputs.oel) > 0 ? Number(inputs.oel) : null;
  const al = Number(inputs.al) > 0 ? Number(inputs.al) : (oel && inputs.alFraction > 0 ? oel * inputs.alFraction : null);
  const res = { inputs, data, allData, oel, al, unit: inputs.unit, ready: false, messages: [] };
  if (!oel) res.messages.push("Enter the occupational exposure limit (OEL).");
  if (data.errors.length) res.messages.push(...data.errors);
  res.gate = gatekeeper(data, inputs.gate, inputs.gateOverride);
  if (!oel || data.n === 0) {
    res.verdict = verdict({ gate: { ...res.gate, allowed: false, status: data.n === 0 ? "none" : res.gate.status, fails: res.gate.fails }, data, oel, al, decision: inputs.decision });
    if (!oel && data.n > 0) res.verdict.title = "Enter the OEL to run the analysis";
    return res;
  }
  res.sae = saeAnalysis(data.rows, inputs.sae, oel);
  res.np = nonparametric(data.rows, oel, al);
  const single = data.n === 1;
  res.single = single;
  if (!res.gate.allowed) {
    res.verdict = verdict({ gate: res.gate, data, oel, al, decision: inputs.decision });
    return res;
  }
  res.fit = fitLognormal(data.rows, inputs.ndMethod);
  res.summary = res.fit && res.fit.n >= 2 && res.fit.sigma > 0 ? lognormalSummary(res.fit, oel, al) : null;
  res.normal = !single ? normalSummary(data.rows, oel) : null;
  res.gof = res.fit && !single ? goodnessOfFit(data.rows, res.fit) : null;
  const bayesOpts = { ...inputs.bayes, informative: single || inputs.bayes.informative };
  const post = bayesLognormal(data.rows, bayesOpts);
  res.posterior = post;
  res.bayes = bayesSummary(post, oel, al, inputs.decision);
  res.worker = !single && res.fit && data.workers.length >= 2 ? workerAnalysis(data.rows, res.fit, oel, inputs.bayes) : null;
  res.comparison = allData.groups.length >= 2 ? compareGroups(allData.rows, pickGroups(allData.groups), oel, al, inputs.ndMethod, inputs.bayes, inputs.decision) : null;
  res.verdict = verdict({ gate: res.gate, data, summary: res.summary, bayes: res.bayes, np: res.np, oel, al, decision: inputs.decision, sae: res.sae, single, unit: inputs.unit, singleGsd: inputs.bayes.singleGsd });
  res.ready = true;
  return res;
}

function pickGroups(groups) {
  const order = g => /before|pre|baseline|old/i.test(g) ? 0 : /after|post|new/i.test(g) ? 2 : 1;
  const sorted = groups.slice().sort((a, b) => order(a) - order(b) || groups.indexOf(a) - groups.indexOf(b));
  return [sorted[0], sorted[1]];
}

export function mergeDefaults(inp) {
  const o = { ...DEFAULTS, ...(inp || {}) };
  o.sae = { ...DEFAULTS.sae, ...(inp && inp.sae || {}) };
  o.gate = { ...DEFAULTS.gate, ...(inp && inp.gate || {}) };
  o.decision = { ...DEFAULTS.decision, ...(inp && inp.decision || {}) };
  o.bayes = { ...DEFAULTS.bayes, ...(inp && inp.bayes || {}) };
  o.alFraction = Number(o.alFraction) >= 0 ? Number(o.alFraction) : 0.5;
  return o;
}

// ---------- Report text ----------

export function reportText(res) {
  const L = [];
  const i = res.inputs;
  const u = res.unit;
  L.push("OEMS EXPOSURE STATISTICS — RESULTS BLOCK");
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} · OEMS Exposure Statistics Tool`);
  L.push("");
  L.push("INPUTS");
  L.push(`Agent: ${i.agent || "—"}   SEG / task: ${i.seg || "—"}${i.task ? " · " + i.task : ""}`);
  L.push(`Assessor: ${i.assessor || "—"}   Assessment date: ${i.date || "—"}`);
  L.push(`OEL: ${res.oel ?? "—"} ${u}   Action level: ${res.al ? fmt(res.al) + " " + u : "—"}`);
  L.push(`Samples: ${res.data.n}${res.data.analyzedGroup ? ` (group "${res.data.analyzedGroup}" of ${res.data.subsetOf})` : ""} (${res.data.nDetected} detected, ${res.data.nCensored} censored)   Non-detect method: ${ndName(i.ndMethod)}`);
  L.push(`Results: ${res.data.rows.map(r => r.display + (r.worker ? " [" + r.worker + "]" : "") + (r.dateText ? " " + r.dateText : "") + (r.group ? " {" + r.group + "}" : "")).join("; ")}`);
  if (res.sae) L.push(`Sampling and analytical error: ±${res.sae.saePct.toFixed(1)}%${res.sae.cvTotal !== null ? ` (total CV ${res.sae.cvTotal.toFixed(3)})` : ""}`);
  L.push("");
  L.push("DATA QUALITY (SEG gatekeeper)");
  L.push(`Result: ${gateName(res.gate.status)}${res.gate.overridden ? " — overridden by the assessor: " + (i.gateReason || "(no reason given)") : ""}`);
  res.gate.items.filter(x => x.level !== "ok").forEach(x => L.push(`- ${x.level === "fail" ? "FAIL" : "CAUTION"}: ${x.text}`));
  if (!res.gate.items.some(x => x.level !== "ok")) L.push("- All checks passed.");
  L.push("");
  if (res.summary) {
    const s = res.summary, b = res.bayes;
    L.push("STATISTICS (lognormal)");
    L.push(`GM ${fmt(s.gm)} ${u} (95% CI ${fmt(s.gmCI[0])} – ${fmt(s.gmCI[1])})   GSD ${fmt(s.gsd)} (95% CI ${fmt(s.gsdCI[0])} – ${fmt(s.gsdCI[1])})`);
    L.push(`AM ${fmt(s.am)} ${u} (95% UCL ${fmt(s.amUCL)}, Cox)`);
    L.push(`95th percentile ${fmt(s.x95)} ${u} = ${pct(s.x95RatioOel)} of OEL; UTL95,95 ${fmt(s.x95UCL)} ${u} = ${pct(s.x95UclRatioOel)} of OEL; lower 95% limit ${fmt(s.x95LCL)} ${u}`);
    L.push(`Exceedance fraction ${pct(s.ef)} (95% CI ${pct(s.efLCL)} – ${pct(s.efUCL)})`);
    if (b) {
      L.push(`Bayesian (90% credible): GM ${fmt(b.gm.median)} [${fmt(b.gm.lo)} – ${fmt(b.gm.hi)}]; GSD ${fmt(b.gsd.median)} [${fmt(b.gsd.lo)} – ${fmt(b.gsd.hi)}]; 95th pct ${fmt(b.x95.median)} [${fmt(b.x95.lo)} – ${fmt(b.x95.hi)}] ${u}; AM ${fmt(b.am.median)} [${fmt(b.am.lo)} – ${fmt(b.am.hi)}] ${u}`);
      L.push(`Overexposure risk P(95th pct > OEL) = ${pct(b.pOverOel)}; P(95th pct > AL) = ${b.pOverAl === null ? "—" : pct(b.pOverAl)}; P(AM > OEL) = ${pct(b.pAmOverOel)}`);
      L.push(`AIHA band probabilities: <10% ${pct(b.bandProbs[0])}; 10–50% ${pct(b.bandProbs[1])}; 50–100% ${pct(b.bandProbs[2])}; >100% ${pct(b.bandProbs[3])}${b.bandProbsPrior ? ` (with decision prior: ${b.bandProbsPrior.map(pct).join("; ")})` : ""}`);
    }
    if (res.gof && res.gof.lognormal) L.push(`Goodness of fit: Shapiro-Wilk W = ${res.gof.lognormal.W.toFixed(3)} (p = ${res.gof.lognormal.p.toFixed(3)}) on the log scale; W = ${res.gof.normal.W.toFixed(3)} (p = ${res.gof.normal.p.toFixed(3)}) on the arithmetic scale → ${res.gof.preferred} fits better.`);
    L.push("");
  } else if (res.bayes && res.single) {
    const b = res.bayes;
    L.push("STATISTICS (one sample, assumed GSD)");
    L.push(`Assumed GSD about ${i.bayes.singleGsd}: 95th percentile ${fmt(b.x95.median)} ${u} [${fmt(b.x95.lo)} – ${fmt(b.x95.hi)}]; P(95th pct > OEL) = ${pct(b.pOverOel)}`);
    L.push("");
  }
  if (res.np) {
    L.push("NON-PARAMETRIC");
    L.push(`Median ${fmt(res.np.median)}; max ${fmt(res.np.max)} ${u}; ${res.np.over} of ${res.np.n} results above the OEL (exact 95% CI on the fraction ${pct(res.np.efCI[0])} – ${pct(res.np.efCI[1])}); the maximum covers the true 95th percentile with ${pct(res.np.maxCoverage)} confidence.`);
    L.push("");
  }
  if (res.sae) {
    L.push("SAMPLING AND ANALYTICAL ERROR (per sample)");
    L.push(`${res.sae.counts.compliant} below the OEL with 95% confidence; ${res.sae.counts.possible} possible overexposure; ${res.sae.counts.over} overexposure.`);
    L.push("");
  }
  if (res.worker) {
    const w = res.worker.anova, wb = res.worker.bayes;
    L.push("BETWEEN / WITHIN WORKER");
    L.push(`${w.k} workers, ${w.N} samples. GSD between workers ${fmt(w.gsdB)}, within ${fmt(w.gsdW)}; R (97.5th/2.5th percentile of worker means) ${fmt(w.R)}; ${pct(w.fracBetween)} of variance between workers.`);
    L.push(`Probability a random worker's 95th percentile exceeds the OEL: ${pct(w.pWorkerX95Over)}${wb ? ` (Bayesian ${pct(wb.pWorkerX95Over)})` : ""}; probability a random worker's mean exceeds the OEL: ${pct(w.theta)}${wb ? ` (Bayesian ${pct(wb.theta)})` : ""}.`);
    L.push("");
  }
  if (res.comparison && !res.comparison.error) {
    const c = res.comparison;
    L.push(`COMPARISON ${c.names[0]} → ${c.names[1]}`);
    L.push(`GM ratio ${fmt(c.gmRatio)} (95% CI ${fmt(c.gmRatioCI[0])} – ${fmt(c.gmRatioCI[1])}), Welch t = ${c.t.toFixed(2)}, p = ${c.pTwo.toFixed(3)}; 95th pct ratio ${fmt(c.bayes.x95Ratio.median)} [${fmt(c.bayes.x95Ratio.lo)} – ${fmt(c.bayes.x95Ratio.hi)}]`);
    L.push(`Probability that ${c.names[1]} is lower than ${c.names[0]}: GM ${pct(c.bayes.pGmBLower)}, 95th percentile ${pct(c.bayes.pX95BLower)}.`);
    L.push("");
  }
  L.push("VERDICT");
  L.push(res.verdict.title.toUpperCase());
  res.verdict.reasons.forEach(t => L.push(`- ${t}`));
  if (res.verdict.alText) L.push(`- ${res.verdict.alText}`);
  L.push("");
  L.push("This tool supports the evaluator's professional judgement and does not replace it.");
  return L.join("\n");
}

export function ndName(m) {
  return { mle: "maximum likelihood (censored MLE)", ros: "robust regression on order statistics (ROS)", half: "substitute DL/2", sqrt2: "substitute DL/√2", dl: "substitute the DL" }[m] || m;
}
export function gateName(s) {
  return { pass: "Pass", caution: "Pass with cautions", fail: "Fail", none: "No data" }[s] || s;
}
