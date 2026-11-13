// Connects the form to the engine, draws the results, charts and report, autosaves the form.
import { analyze, reportText, parseSamples as E_parse, fmt, pct, BANDS, GATE_QUESTIONS, ndName, gateName, DEFAULTS } from "./engine.js";
import * as C from "./charts.js";

const $ = id => document.getElementById(id);
const form = $("form");
const SAVE_KEY = "oems_exposure_stats_v1";
let lastResult = null;

// ---------- Worked example ----------

const EXAMPLE = {
  agent: "Toluene", unit: "ppm", oel: 20, alFraction: 0.5, seg: "Spray booth operators, line 2",
  task: "Full-shift TWA, solvent-based coating application", assessor: "J. Smith, CIH", date: "2026-11-13",
  notes: "Charcoal tubes, NIOSH 1501. Booth ventilation serviced 15 Feb 2026 (before / after groups).",
  samplesText: [
    "result,worker,date,group",
    "6.8,W1,2026-01-12,before", "11.2,W2,2026-01-12,before", "4.1,W3,2026-01-19,before", "15.6,W1,2026-01-26,before",
    "9.3,W2,2026-02-02,before", "<2.0,W3,2026-02-02,before", "7.7,W1,2026-02-09,before",
    "3.2,W1,2026-03-02,after", "2.6,W2,2026-03-02,after", "5.9,W3,2026-03-09,after", "<2.0,W1,2026-03-16,after",
    "4.4,W2,2026-03-23,after", "3.0,W3,2026-03-23,after", "2.1,W1,2026-04-06,after"
  ].join("\n"),
  ndMethod: "mle", analyzeGroup: "after", saeMode: "cv", cvAnalytical: 0.08, cvSampling: 0.05, saePct: 25,
  goThreshold: 5, nogoThreshold: 30, usePrior: false, prior1: 25, prior2: 25, prior3: 25, prior4: 25, singleGsd: 2.5, seed: 20261113
};

// ---------- Form <-> inputs ----------

function val(id) { const el = $(id); return el ? el.value : ""; }
function num(id) { const v = parseFloat(val(id)); return Number.isFinite(v) ? v : null; }

function readInputs() {
  const gate = {};
  for (const q of GATE_QUESTIONS) gate[q.key] = (form.querySelector(`input[name="gate_${q.key}"]:checked`) || {}).value || "yes";
  return {
    agent: val("agent"), unit: val("unit") || "mg/m³", oel: num("oel"), alFraction: num("alFraction") ?? 0.5, al: num("alValue"),
    seg: val("seg"), task: val("task"), assessor: val("assessor"), date: val("date"), notes: val("notes"),
    samplesText: val("samples"),
    analyzeGroup: val("analyzeGroup") || "",
    ndMethod: val("ndMethod") || "mle",
    sae: { mode: val("saeMode") || "cv", saePct: num("saePct") ?? 25, cvAnalytical: num("cvAnalytical") ?? 0.1, cvSampling: num("cvSampling") ?? 0.05 },
    gate, gateOverride: $("gateOverride").checked, gateReason: val("gateReason"),
    decision: {
      goThreshold: (num("goThreshold") ?? 5) / 100, nogoThreshold: (num("nogoThreshold") ?? 30) / 100,
      usePrior: $("usePrior").checked, prior: normalisePrior([num("prior1"), num("prior2"), num("prior3"), num("prior4")])
    },
    bayes: { ...DEFAULTS.bayes, singleGsd: num("singleGsd") ?? 2.5, seed: num("seed") ?? DEFAULTS.bayes.seed, informative: $("informative").checked }
  };
}
function normalisePrior(p) {
  const q = p.map(v => (Number.isFinite(v) && v >= 0 ? v : 0));
  const t = q.reduce((a, b) => a + b, 0);
  return t > 0 ? q.map(v => v / t) : [0.25, 0.25, 0.25, 0.25];
}

function fillForm(o) {
  syncGroupOptions(E_parse(o.samplesText || ""), o.analyzeGroup || "");
  for (const k of ["agent", "unit", "oel", "alFraction", "alValue", "seg", "task", "assessor", "date", "notes", "samples", "analyzeGroup", "ndMethod", "saeMode", "saePct", "cvAnalytical", "cvSampling", "goThreshold", "nogoThreshold", "prior1", "prior2", "prior3", "prior4", "singleGsd", "seed", "gateReason"]) {
    const el = $(k);
    if (!el) continue;
    const src = k === "samples" ? o.samplesText : o[k];
    el.value = src === undefined || src === null ? "" : src;
  }
  $("usePrior").checked = !!o.usePrior;
  $("informative").checked = !!o.informative;
  $("gateOverride").checked = !!o.gateOverride;
  for (const q of GATE_QUESTIONS) {
    const v = (o.gate && o.gate[q.key]) || "yes";
    const el = form.querySelector(`input[name="gate_${q.key}"][value="${v}"]`);
    if (el) el.checked = true;
  }
}

function snapshot() {
  const o = {};
  for (const el of form.querySelectorAll("input, select, textarea")) {
    if (!el.id && !el.name) continue;
    if (el.type === "radio") { if (el.checked) o[el.name] = el.value; }
    else if (el.type === "checkbox") o[el.id] = el.checked;
    else o[el.id] = el.value;
  }
  return o;
}
function restore(o) {
  for (const el of form.querySelectorAll("input, select, textarea")) {
    if (el.type === "radio") { if (o[el.name] !== undefined) el.checked = el.value === o[el.name]; }
    else if (el.type === "checkbox") { if (o[el.id] !== undefined) el.checked = !!o[el.id]; }
    else if (o[el.id] !== undefined) el.value = o[el.id];
  }
}

// ---------- Rendering ----------

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
const text = (id, t) => { const el = $(id); if (el) el.textContent = t; };
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
const ci = (a, b) => `${fmt(a)} – ${fmt(b)}`;
const cred = s => `${fmt(s.median)} <small>[${fmt(s.lo)} – ${fmt(s.hi)}]</small>`;

function statusClass(s) { return s === "go" ? "ok" : s === "nogo" ? "stop" : s === "more" ? "warn" : "pending"; }
function statusWord(s) { return s === "go" ? "GO" : s === "nogo" ? "NO-GO" : s === "more" ? "NEEDS MORE DATA" : s === "withheld" ? "WITHHELD" : "—"; }

function render(res) {
  lastResult = res;
  const u = res.unit;
  // messages
  set("messages", res.messages.length ? `<ul>${res.messages.map(m => `<li>${esc(m)}</li>`).join("")}</ul>` : "");
  // data preview
  renderData(res);
  // gatekeeper
  renderGate(res);
  // verdict and stoplight
  renderVerdict(res);
  // stats
  renderStats(res);
  // charts
  renderCharts(res);
  // detail sections
  renderSae(res); renderWorker(res); renderComparison(res);
  // report
  text("reportBlock", res.ready || res.verdict ? reportText(res) : "");
  // sticky results panel
  renderPanel(res);
  // menu statuses
  updateMenuState(res);
}

function syncGroupOptions(parsed, keep) {
  const sel = $("analyzeGroup");
  const current = keep !== undefined ? keep : sel.value;
  const groups = parsed.groups || [];
  sel.innerHTML = `<option value="">All samples${groups.length ? " (pooled)" : ""}</option>` + groups.map(g => `<option value="${esc(g)}">${esc(g)} only</option>`).join("");
  sel.value = groups.includes(current) ? current : "";
  sel.disabled = groups.length < 2;
}

function renderData(res) {
  syncGroupOptions(res.allData);
  const d = res.allData;
  set("dataSummary", d.n === 0 ? `<span class="muted">No samples yet. One result per line; add a worker ID, a date and a group after commas to unlock the worker, trend and comparison analyses.</span>` :
    `<b>${d.n}</b> samples · <b>${d.nDetected}</b> detected · <b>${d.nCensored}</b> censored (${d.nLeft} below DL, ${d.nRight} above range, ${d.nInterval} ranges) · workers: <b>${d.workers.length || "none"}</b> · groups: <b>${d.groups.length ? d.groups.join(", ") : "none"}</b> · dates: <b>${d.hasDates ? "all" : d.rows.some(r => r.date) ? "some" : "none"}</b>`);
  if (d.n === 0) { set("dataTable", ""); return; }
  const used = new Set(res.data.rows.map(r => r.index));
  const rows = d.rows.map(r => `<tr class="${used.has(r.index) ? "" : "unused"}"><td class="c">${r.index}</td><td>${esc(r.display)}${r.censored ? ` <span class="tag">${r.type === "lt" ? "non-detect" : r.type === "gt" ? "above range" : "range"}</span>` : ""}</td><td>${esc(r.worker || "")}</td><td>${esc(r.dateText)}</td><td>${esc(r.group || "")}</td><td>${esc(r.note)}</td></tr>`).join("");
  set("dataTable", `<div class="tablewrap"><table class="data"><thead><tr><th>#</th><th>Result (${esc(res.unit)})</th><th>Worker</th><th>Date</th><th>Group</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function renderGate(res) {
  const g = res.gate;
  const cls = g.status === "pass" ? "ok" : g.status === "caution" ? "warn" : g.status === "fail" ? "stop" : "pending";
  const head = g.status === "none" ? "Enter sample results to run the data-quality check" : g.status === "pass" ? "Pass: the samples can be pooled as one SEG" : g.status === "caution" ? "Pass with cautions: the statistics run, read the notes" : g.overridden ? "Failed, overridden by the assessor: the statistics run but the report records the failure" : "Fail: the statistics are withheld until the data describe one exposure situation";
  set("gateResult", `<div class="gate-head ${cls}"><span class="gate-badge">${esc(gateName(g.status))}</span><span>${esc(head)}</span></div>
    <ul class="gate-list">${g.items.map(i => `<li class="${i.level}"><span class="dot"></span>${esc(i.text)}</li>`).join("")}</ul>`);
  show("gateOverrideWrap", g.status === "fail");
}

function renderVerdict(res) {
  const v = res.verdict;
  const cls = statusClass(v.status);
  set("verdictTitle", `<span class="pill ${cls}">${statusWord(v.status)}</span><h3 class="vt ${cls}">${esc(v.title)}</h3>`);
  set("verdictReasons", `<ul>${v.reasons.map(r => `<li>${esc(r)}</li>`).join("")}${v.alText ? `<li class="al">${esc(v.alText)}</li>` : ""}</ul>`);
  const b = res.bayes;
  const probs = b ? (res.inputs.decision.usePrior && b.bandProbsPrior ? b.bandProbsPrior : b.bandProbs) : null;
  set("stoplight", C.stoplight({ marker: v.marker, lo: v.lo, hi: v.hi, probs, status: v.status }));
  set("gateChip", `<span class="gchip ${res.gate.status}">Data quality: ${esc(gateName(res.gate.status))}${res.gate.overridden ? " (overridden)" : ""}</span>`);
  show("bayesDecision", !!b && !res.single);
  if (b && !res.single) set("bandBars", C.bandBars(b.bandProbs, b.bandProbsPrior));
}

function renderStats(res) {
  const s = res.summary, b = res.bayes, u = res.unit;
  show("statsWrap", !!s || !!(res.single && b));
  show("singleWrap", !!res.single);
  if (res.single && b) {
    set("singleStats", `<p>With one sample the spread cannot be estimated from the data. The Bayesian view assumes a GSD of about <b>${esc(res.inputs.bayes.singleGsd)}</b> (prior on the log-GSD) and treats the sample as drawn from that distribution.</p>
      <dl class="kv"><dt>95th percentile</dt><dd>${cred(b.x95)} ${esc(u)}</dd><dt>Overexposure risk P(95th pct &gt; OEL)</dt><dd>${pct(b.pOverOel)}</dd><dt>AM</dt><dd>${cred(b.am)} ${esc(u)}</dd></dl>`);
  }
  if (!s) { set("keyNumbers", ""); set("statsTable", ""); set("gofBox", ""); set("npBox", ""); return; }
  set("keyNumbers", `
    <div class="kn"><span class="kl">95th percentile</span><span class="kvv">${fmt(s.x95)} <small>${esc(u)}</small></span><span class="ks">${pct(s.x95RatioOel)} of OEL · ${esc(s.band.name)}</span></div>
    <div class="kn"><span class="kl">UTL<sub>95,95</sub> (upper limit on the 95th pct)</span><span class="kvv">${fmt(s.x95UCL)} <small>${esc(u)}</small></span><span class="ks">${pct(s.x95UclRatioOel)} of OEL</span></div>
    <div class="kn"><span class="kl">Overexposure risk</span><span class="kvv">${b ? pct(b.pOverOel) : "—"}</span><span class="ks">P(95th pct &gt; OEL), Bayesian</span></div>
    <div class="kn"><span class="kl">Exceedance fraction</span><span class="kvv">${pct(s.ef)}</span><span class="ks">95% UCL ${pct(s.efUCL)}</span></div>
    <div class="kn"><span class="kl">Geometric mean</span><span class="kvv">${fmt(s.gm)} <small>${esc(u)}</small></span><span class="ks">95% CI ${ci(s.gmCI[0], s.gmCI[1])}</span></div>
    <div class="kn"><span class="kl">Geometric SD</span><span class="kvv">${fmt(s.gsd)}</span><span class="ks">95% CI ${ci(s.gsdCI[0], s.gsdCI[1])}</span></div>
    <div class="kn"><span class="kl">Arithmetic mean</span><span class="kvv">${fmt(s.am)} <small>${esc(u)}</small></span><span class="ks">95% UCL ${fmt(s.amUCL)} (Cox)</span></div>
    <div class="kn"><span class="kl">Action level</span><span class="kvv">${res.al ? pct(s.x95RatioAl) : "—"}</span><span class="ks">${res.al ? `95th pct as % of AL (${fmt(res.al)} ${esc(u)}); P(&gt; AL) ${b && b.pOverAl !== null ? pct(b.pOverAl) : "—"}` : "no action level set"}</span></div>`);
  const row = (label, freq, bay) => `<tr><th>${label}</th><td>${freq}</td><td>${bay}</td></tr>`;
  set("statsTable", `<div class="tablewrap"><table class="data stats"><thead><tr><th>Lognormal estimate</th><th>Frequentist (MLE / exact)</th><th>Bayesian (median [90% credible])</th></tr></thead><tbody>
    ${row("Geometric mean (GM)", `${fmt(s.gm)} ${esc(u)} <small>95% CI ${ci(s.gmCI[0], s.gmCI[1])}</small>`, b ? `${cred(b.gm)} ${esc(u)}` : "—")}
    ${row("Geometric standard deviation (GSD)", `${fmt(s.gsd)} <small>95% CI ${ci(s.gsdCI[0], s.gsdCI[1])}</small>`, b ? cred(b.gsd) : "—")}
    ${row("Arithmetic mean (AM)", `${fmt(s.am)} ${esc(u)} <small>95% UCL ${fmt(s.amUCL)}, 95% CI ${ci(s.amCI95[0], s.amCI95[1])} (Cox)</small>`, b ? `${cred(b.am)} ${esc(u)} <small>P(AM &gt; OEL) ${pct(b.pAmOverOel)}</small>` : "—")}
    ${row("95th percentile (X<sub>95</sub>)", `${fmt(s.x95)} ${esc(u)} <small>lower 95% limit ${fmt(s.x95LCL)}, UTL<sub>95,95</sub> ${fmt(s.x95UCL)} (K = ${s.K95.toFixed(3)})</small>`, b ? `${cred(b.x95)} ${esc(u)}` : "—")}
    ${row("Exceedance fraction (&gt; OEL)", `${pct(s.ef)} <small>95% CI ${pct(s.efLCL)} – ${pct(s.efUCL)}</small>`, b ? `${pct(b.ef.median)} <small>[${pct(b.ef.lo)} – ${pct(b.ef.hi)}]</small>` : "—")}
    ${row("P(more than 5% exceed the OEL)", `${s.x95UclRatioOel < 1 ? "&lt; 5% (UTL below the OEL)" : s.x95LclRatioOel > 1 ? "&gt; 95% (lower limit above the OEL)" : "between 5% and 95% (limits straddle the OEL)"}`, b ? pct(b.pEf5) : "—")}
    ${res.al ? row("Exceedance fraction (&gt; action level)", pct(s.efAl), b && b.pOverAl !== null ? `P(X<sub>95</sub> &gt; AL) ${pct(b.pOverAl)}` : "—") : ""}
    </tbody></table></div>
    <p class="note">Non-detect method: ${esc(ndName(res.fit.method))}${res.fit.note ? " (" + esc(res.fit.note) + ")" : ""}. Bayesian posterior from ${b ? b.draws : 0} Gibbs draws (seed ${esc(res.inputs.bayes.seed)}), flat prior on log GM and uniform prior on log GSD up to 10, as in Expostats.</p>`);
  // goodness of fit
  const g = res.gof;
  if (g && g.lognormal) {
    const nrm = res.normal;
    set("gofBox", `<div class="gof ${g.lognormalOk ? "ok" : "warn"}"><b>${g.lognormalOk ? "Lognormal fit acceptable" : "Lognormal fit questionable"}</b>: Shapiro-Wilk W = ${g.lognormal.W.toFixed(3)}, p = ${g.lognormal.p.toFixed(3)} on the log scale${Number.isFinite(g.filliben) ? `; probability-plot correlation r = ${g.filliben.toFixed(3)}` : ""}.
      Normal (arithmetic) scale: W = ${g.normal.W.toFixed(3)}, p = ${g.normal.p.toFixed(3)} → <b>${g.preferred === "lognormal" ? "the lognormal describes the data better" : "the normal describes the data better"}</b>.${g.note ? " " + esc(g.note) : ""}
      ${nrm ? `<br>If a normal distribution is assumed instead: mean ${fmt(nrm.mean)} ${esc(u)}, SD ${fmt(nrm.sdev)}, 95th percentile ${fmt(nrm.x95)} (UTL<sub>95,95</sub> ${fmt(nrm.x95UCL)}), exceedance fraction ${pct(nrm.ef)}.` : ""}
      ${!g.lognormalOk && !g.normalOk ? "<br>Neither distribution fits well: rely on the non-parametric view and check the gatekeeper notes (mixed SEG? outlier?)." : ""}</div>`);
  } else set("gofBox", g && g.note ? `<div class="gof">${esc(g.note)}</div>` : "");
  const np = res.np;
  set("npBox", np ? `<dl class="kv"><dt>Median</dt><dd>${fmt(np.median)} ${esc(u)}</dd><dt>Minimum / maximum</dt><dd>${fmt(np.min)} / ${fmt(np.max)} ${esc(u)}</dd><dt>Empirical 95th percentile (Hazen)</dt><dd>${fmt(np.p95)} ${esc(u)}</dd>
    <dt>Results above the OEL</dt><dd>${np.over} of ${np.n} (${pct(np.ef)}; exact 95% CI ${pct(np.efCI[0])} – ${pct(np.efCI[1])})</dd>${res.al ? `<dt>Results above the action level</dt><dd>${np.overAl} of ${np.n}</dd>` : ""}
    <dt>Maximum as an upper tolerance limit</dt><dd>${pct(np.maxCoverage)} confidence that the largest result is at or above the true 95th percentile (59 samples give 95%)</dd></dl>` : "");
}

function renderCharts(res) {
  const s = res.summary, u = res.unit;
  const has = res.data.n > 0 && res.oel;
  show("chartsWrap", !!has);
  if (!has) return;
  set("chartSequence", C.sequencePlot({ rows: res.data.rows, oel: res.oel, al: res.al, x95: s ? s.x95 : null, unit: u, byWorker: res.data.workers.length >= 2 }));
  set("chartQQ", s && res.gof ? C.qqPlot({ qq: res.gof.qq, mu: res.fit.mu, sigma: res.fit.sigma, unit: u }) : "");
  set("chartDensity", s ? C.densityPlot({ mu: res.fit.mu, sigma: res.fit.sigma, rows: res.data.rows, oel: res.oel, al: res.al, unit: u, x95: s.x95 }) : "");
  set("chartPosterior", res.posterior && !res.single ? C.posteriorPlot({ draws: Array.from(res.posterior.mus).map((m, i) => Math.exp(m + 1.6448536269514722 * res.posterior.sigmas[i])), oel: res.oel, unit: u }) : "");
  show("chartQQWrap", !!(s && res.gof)); show("chartDensityWrap", !!s); show("chartPosteriorWrap", !!(res.posterior && !res.single));
}

function renderSae(res) {
  const sae = res.sae;
  show("saeWrap", !!sae);
  if (!sae) return;
  const col = { compliant: "ok", possible: "warn", over: "stop" };
  set("saeSummary", `<p>Sampling and analytical error (SAE) = <b>±${sae.saePct.toFixed(1)}%</b>${sae.cvTotal !== null ? ` from a total CV of ${sae.cvTotal.toFixed(3)} (1.645 × CV<sub>total</sub>, CV<sub>total</sub> = √(CV<sub>analytical</sub>² + CV<sub>sampling</sub>²))` : " (entered directly)"}. Each sample is compared with the OEL on its own: <b>${sae.counts.compliant}</b> below the OEL with 95% confidence, <b>${sae.counts.possible}</b> possible overexposure, <b>${sae.counts.over}</b> overexposure.</p>`);
  set("saeChart", C.saePlot({ perSample: sae.perSample, unit: res.unit }));
  set("saeTable", `<div class="tablewrap"><table class="data"><thead><tr><th>#</th><th>Result</th><th>Fraction of OEL</th><th>LCL</th><th>UCL</th><th>Classification</th></tr></thead><tbody>${sae.perSample.map(p => `<tr><td class="c">${p.index}</td><td>${esc(p.display)}</td><td>${pct(p.y)}</td><td>${pct(p.lcl)}</td><td>${pct(p.ucl)}</td><td class="cls"><span class="${col[p.cls]}">${esc(p.text)}</span></td></tr>`).join("")}</tbody></table></div>`);
}

function renderWorker(res) {
  const w = res.worker;
  show("workerWrap", !!w);
  if (!w) { if (res.data.n > 0) set("workerNone", res.data.workers.length < 2 ? "Add a worker ID after each result (e.g. 4.2, W1) with two or more workers to estimate between- and within-worker variance." : ""); return; }
  const a = w.anova, b = w.bayes, u = res.unit;
  set("workerBox", `<dl class="kv">
    <dt>Workers / samples</dt><dd>${a.k} / ${a.N} (${a.withRepeats} workers with repeat samples)</dd>
    <dt>GSD between workers</dt><dd>${fmt(a.gsdB)}${b ? ` <small>Bayesian ${cred(b.gsdB)}</small>` : ""}</dd>
    <dt>GSD within workers (day to day)</dt><dd>${fmt(a.gsdW)}${b ? ` <small>Bayesian ${cred(b.gsdW)}</small>` : ""}</dd>
    <dt>Share of variance between workers</dt><dd>${pct(a.fracBetween)} <small>(ANOVA F = ${Number.isFinite(a.F) ? a.F.toFixed(2) : "—"}, p = ${Number.isFinite(a.pF) ? a.pF.toFixed(3) : "—"})</small></dd>
    <dt>R (97.5th / 2.5th percentile of worker means)</dt><dd>${fmt(a.R)}${b ? ` <small>Bayesian ${cred(b.R)}; P(R &gt; 2) ${pct(b.pRabove2)}</small>` : ""} — ${a.R > 10 ? "<b>above 10: the SEG is probably not homogeneous; some workers are exposed very differently</b>" : a.R > 2 ? "above 2: workers differ meaningfully; consider whether the SEG should be split" : "below 2: the workers' exposures are alike"}</dd>
    <dt>Probability a random worker's own 95th percentile exceeds the OEL</dt><dd>${pct(a.pWorkerX95Over)}${b ? ` <small>Bayesian ${pct(b.pWorkerX95Over)} [${pct(b.pWorkerX95OverCI.lo)} – ${pct(b.pWorkerX95OverCI.hi)}]</small>` : ""}</dd>
    <dt>Probability a random worker's mean exposure exceeds the OEL (Rappaport's θ)</dt><dd>${pct(a.theta)}${b ? ` <small>Bayesian ${pct(b.theta)}</small>` : ""}</dd></dl>
    <p class="note">One-way random-effects ANOVA on the log results (censored values by the chosen non-detect method), and a Bayesian random-effects model (Gibbs sampling, uniform priors on both log-GSDs). With few workers the Bayesian between-worker GSD is very uncertain; the ANOVA value is the point estimate.</p>`);
  set("workerChart", C.workerPlot({ rows: res.data.rows, workers: w.groups, oel: res.oel, al: res.al, unit: u }));
}

function renderComparison(res) {
  const c = res.comparison;
  show("compareWrap", !!c);
  if (!c) { if (res.data.n > 0) set("compareNone", res.data.groups.length < 2 ? "Add a group label as the fourth column (e.g. before / after) to compare two sets of samples." : ""); return; }
  if (c.error) { set("compareBox", `<p class="note">${esc(c.names.join(" vs "))}: ${esc(c.error)}.</p>`); set("compareChart", ""); return; }
  const u = res.unit, [na, nb] = c.names;
  const cell = (g) => `GM ${fmt(g.summary.gm)}, GSD ${fmt(g.summary.gsd)}, 95th pct ${fmt(g.summary.x95)} ${esc(u)} (${pct(g.summary.x95RatioOel)} of OEL), overexposure risk ${pct(g.bayes.pOverOel)}`;
  set("compareBox", `<div class="tablewrap"><table class="data"><thead><tr><th></th><th>${esc(na)} (n = ${c.A.n})</th><th>${esc(nb)} (n = ${c.B.n})</th></tr></thead><tbody>
    <tr><th>Lognormal summary</th><td>${cell(c.A)}</td><td>${cell(c.B)}</td></tr></tbody></table></div>
    <dl class="kv">
    <dt>Ratio of geometric means (${esc(nb)} / ${esc(na)})</dt><dd>${fmt(c.gmRatio)} <small>95% CI ${ci(c.gmRatioCI[0], c.gmRatioCI[1])}; Welch t = ${c.t.toFixed(2)}, df = ${c.dfW.toFixed(1)}, p = ${c.pTwo.toFixed(3)}</small></dd>
    <dt>Ratio of 95th percentiles (Bayesian)</dt><dd>${cred(c.bayes.x95Ratio)}</dd>
    <dt>Probability that ${esc(nb)} is lower than ${esc(na)}</dt><dd>GM ${pct(c.bayes.pGmBLower)} · 95th percentile ${pct(c.bayes.pX95BLower)} · AM ${pct(c.bayes.pAmBLower)}</dd>
    <dt>Spread (GSD) changed?</dt><dd>F = ${c.F.toFixed(2)}, p = ${c.pF.toFixed(3)} ${c.pF < 0.05 ? "(the GSDs differ)" : "(no evidence the GSDs differ)"}</dd>
    <dt>Reading</dt><dd>${c.bayes.pX95BLower >= 0.95 ? `<b>${esc(nb)} is lower than ${esc(na)} with high probability: the change worked.</b>` : c.bayes.pX95BLower <= 0.05 ? `<b>${esc(nb)} is higher than ${esc(na)}.</b>` : `The difference is not conclusive at this sample size (${pct(c.bayes.pX95BLower)} probability that ${esc(nb)} is lower).`} ${c.B.bayes.pOverOel < res.inputs.decision.goThreshold ? `${esc(nb)} on its own meets the go threshold.` : `${esc(nb)} on its own does not yet meet the go threshold (overexposure risk ${pct(c.B.bayes.pOverOel)}).`}</dd></dl>`);
  set("compareChart", C.comparePlot({ A: c.A.fit, B: c.B.fit, names: c.names, oel: res.oel, al: res.al, unit: u }));
}

function renderPanel(res) {
  const v = res.verdict, s = res.summary, b = res.bayes, u = res.unit;
  const cls = statusClass(v.status);
  set("pStatus", `<span class="pill ${cls}">${statusWord(v.status)}</span>`);
  const hero = $("pHero");
  if (s) { hero.textContent = pct(s.x95RatioOel); hero.className = "hero " + (v.status === "go" ? "" : v.status === "nogo" ? "vhigh" : "med"); text("pHeroLabel", "95th percentile as a fraction of the OEL"); }
  else if (res.single && v.marker !== null && v.marker !== undefined) { hero.textContent = pct(v.marker); hero.className = "hero " + (v.status === "go" ? "" : v.status === "nogo" ? "vhigh" : "med"); text("pHeroLabel", "the one sample as a fraction of the OEL"); }
  else { hero.textContent = "—"; hero.className = "hero pending"; text("pHeroLabel", res.data.n === 0 ? "enter sample results" : !res.oel ? "enter the OEL" : "no estimate"); }
  text("pTitle", v.title);
  set("pGate", `<span class="gchip ${res.gate.status}">Data quality: ${esc(gateName(res.gate.status))}</span>`);
  set("pFacts", s ? `
    <div><dt>UTL<sub>95,95</sub></dt><dd>${pct(s.x95UclRatioOel)} of OEL</dd></div>
    <div><dt>Overexposure risk</dt><dd>${b ? pct(b.pOverOel) : "—"}</dd></div>
    <div><dt>GM / GSD</dt><dd>${fmt(s.gm)} ${esc(u)} / ${fmt(s.gsd)}</dd></div>
    <div><dt>Exceedance fraction</dt><dd>${pct(s.ef)}</dd></div>
    <div><dt>AIHA band</dt><dd>${esc(s.band.name)} (${esc(s.band.short)})</dd></div>
    <div><dt>Action level</dt><dd>${res.al ? pct(s.x95RatioAl) + " of AL" : "—"}</dd></div>` : "");
}

function updateMenuState(res) {
  const st = { data: res.data.n > 0, gate: res.gate.status !== "none", results: res.ready };
  for (const [k, on] of Object.entries(st)) { const a = document.querySelector(`.toc a[data-state="${k}"]`); if (a) a.classList.toggle("done", on); }
}

// ---------- Wiring ----------

let timer = null;
function recalc() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { render(analyze(readInputs())); }
    catch (e) { console.error(e); set("messages", `<ul><li>Something went wrong in the calculation: ${esc(e.message)}</li></ul>`); }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); } catch (e) { /* storage unavailable */ }
    syncVisibility();
  }, 120);
}

function syncVisibility() {
  const mode = val("saeMode");
  show("saeCvFields", mode !== "direct"); show("saeDirectField", mode === "direct");
  show("priorFields", $("usePrior").checked);
  const alv = num("alValue");
  const alf = $("alFraction"); if (alf) alf.disabled = alv !== null && alv > 0;
}

form.addEventListener("input", recalc);
form.addEventListener("change", recalc);
form.addEventListener("submit", e => e.preventDefault());

$("loadExample").addEventListener("click", () => { fillForm(EXAMPLE); recalc(); });
$("clearAll").addEventListener("click", () => {
  if (!confirm("Clear every entry on the page?")) return;
  form.reset(); fillForm({ unit: "mg/m³", alFraction: 0.5, ndMethod: "mle", saeMode: "cv", cvAnalytical: 0.10, cvSampling: 0.05, saePct: 25, goThreshold: 5, nogoThreshold: 30, prior1: 25, prior2: 25, prior3: 25, prior4: 25, singleGsd: 2.5, seed: DEFAULTS.bayes.seed });
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  recalc();
});
$("copyReport").addEventListener("click", async () => {
  const t = $("reportBlock").textContent;
  try { await navigator.clipboard.writeText(t); flash("copyReport", "Copied"); } catch (e) { $("reportBlock").focus(); $("reportBlock").select(); }
});
$("downloadReport").addEventListener("click", () => download(`exposure-stats-${stamp()}.txt`, $("reportBlock").textContent, "text/plain"));
$("downloadJson").addEventListener("click", () => {
  if (!lastResult) return;
  const out = { tool: "OEMS Exposure Statistics Tool", generated: new Date().toISOString(), inputs: lastResult.inputs, results: stripBig(lastResult) };
  download(`exposure-stats-${stamp()}.json`, JSON.stringify(out, null, 1), "application/json");
});
$("downloadCsv").addEventListener("click", () => {
  if (!lastResult) return;
  const lines = ["index,result,type,low,high,worker,date,group,note", ...lastResult.data.rows.map(r => [r.index, r.display, r.type, r.lo, Number.isFinite(r.hi) ? r.hi : "", r.worker || "", r.dateText, r.group || "", r.note].map(csv).join(","))];
  download(`exposure-stats-data-${stamp()}.csv`, lines.join("\n"), "text/csv");
});
$("printPage").addEventListener("click", () => { document.querySelectorAll("details").forEach(d => { d.open = true; }); window.print(); });

function stripBig(res) {
  const o = { ...res };
  delete o.posterior; delete o.inputs;
  o.data = { ...res.data, rows: res.data.rows.map(r => ({ ...r, date: r.date ? r.date.toISOString().slice(0, 10) : null })) };
  if (o.gof) o.gof = { ...o.gof, qq: undefined };
  return o;
}
function csv(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function stamp() { return new Date().toISOString().slice(0, 10); }
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function flash(id, label) { const el = $(id), old = el.textContent; el.textContent = label; setTimeout(() => { el.textContent = old; }, 1200); }

// Section menu: highlight the section in view
const links = [...document.querySelectorAll(".toc a[href^='#']")];
const sections = links.map(a => document.querySelector(a.getAttribute("href"))).filter(Boolean);
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) links.forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id)); });
  }, { rootMargin: "-20% 0px -70% 0px" });
  sections.forEach(s => io.observe(s));
}

// Start: restore the last session or load the example on the first visit
let restored = false;
try { const saved = localStorage.getItem(SAVE_KEY); if (saved) { restore(JSON.parse(saved)); restored = true; } } catch (e) { /* ignore */ }
if (!restored) fillForm(EXAMPLE);
syncVisibility();
render(analyze(readInputs()));
