// Checks the engine against values from SciPy (tests/reference.json, written by scripts/make-reference.py),
// against published one-sided tolerance factors, and against hand-worked properties of the analysis.
// Run: node tests/check.mjs   (exit code 0 when every check passes)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as N from "../numeric.js";
import * as E from "../engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const R = JSON.parse(fs.readFileSync(path.join(here, "reference.json"), "utf8"));

let failures = 0, checks = 0;
function close(name, got, want, tol = 1e-9) {
  checks++;
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol * (1 + Math.abs(want));
  if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
}
function truthy(name, cond, detail = "") {
  checks++;
  if (!cond) { failures++; console.log(`FAIL ${name} ${detail}`); }
}

// ---- Distributions vs SciPy ----
for (const [x, v] of R.pnorm) close(`pnorm(${x})`, N.pnorm(x), v, 1e-12);
for (const [p, v] of R.qnorm) close(`qnorm(${p})`, N.qnorm(p), v, 1e-9);
for (const [p, df, v] of R.qt) close(`qt(${p},${df})`, N.qt(p, df), v, 1e-7);
for (const [t, df, v] of R.pt) close(`pt(${t},${df})`, N.pt(t, df), v, 1e-10);
for (const [p, df, v] of R.qchisq) close(`qchisq(${p},${df})`, N.qchisq(p, df), v, 1e-7);
for (const [x, a, b, v] of R.pbeta) close(`pbeta(${x},${a},${b})`, N.pbeta(x, a, b), v, 1e-10);
for (const [x, v] of R.lgamma) close(`lgamma(${x})`, N.lgamma(x), v, 1e-10);
for (const [t, df, d, v] of R.pnt) close(`pnt(${t},${df},${d})`, N.pnt(t, df, d), v, 1e-8);
for (const [p, df, d, v] of R.qnt) close(`qnt(${p},${df},${d})`, N.qnt(p, df, d), v, 1e-6);
for (const [n, v] of R.kFactor) close(`kFactor(${n})`, N.kFactor(n), v, 1e-6);
// Published one-sided tolerance factors (95% coverage, 95% confidence), e.g. NIST handbook / Natrella
for (const [n, k] of [[3, 7.656], [5, 4.203], [10, 2.911], [20, 2.396], [30, 2.220], [50, 2.065]]) close(`published K(${n})`, N.kFactor(n), k, 1e-3);

// ---- Shapiro-Wilk vs SciPy ----
for (const s of R.shapiro) {
  const r = N.shapiroWilk(s.x);
  close(`Shapiro-Wilk W [${s.name}]`, r.W, s.W, 1e-6);
  close(`Shapiro-Wilk p [${s.name}]`, r.p, s.p, 2e-4);
}

// ---- Censored MLE vs SciPy ----
{
  const c = R.censoredMLE.data;
  const text = [...c.uncensored.map(String), ...c.left.map(v => "<" + v), ...c.right.map(v => ">" + v), ...c.interval_lo.map((lo, i) => lo + "-" + c.interval_hi[i])].join("\n");
  const d = E.parseSamples(text);
  truthy("parse censored set", d.n === 13 && d.errors.length === 0 && d.nLeft === 3 && d.nRight === 1 && d.nInterval === 1);
  const f = E.fitMLE(d.rows);
  close("censored MLE mu", f.mu, R.censoredMLE.mu, 2e-4);
  close("censored MLE sigma", f.sigma, R.censoredMLE.sigma, 2e-4);
  const d2 = E.parseSamples(R.plainMLE.data.join("\n"));
  const f2 = E.fitMLE(d2.rows);
  close("plain MLE mu", f2.mu, R.plainMLE.mu, 1e-5);
  close("plain MLE sigma", f2.sigma, R.plainMLE.sigma, 1e-4);
}

// ---- Welch t-test and Spearman vs SciPy ----
{
  const text = ["result,group", ...R.welch.A.map(v => v + ",A"), ...R.welch.B.map(v => v + ",B")].join("\n");
  const res = E.analyze({ samplesText: text, oel: 10, bayes: { draws: 500, burn: 100 } });
  close("Welch t (second group relative to the first)", res.comparison.t, -R.welch.t, 1e-8);
  close("Welch p", res.comparison.pTwo, R.welch.p, 1e-7);
  const sp = R.spearman;
  const lines = sp.x.map((d, i) => `${sp.y[i]},,2026-01-${String(d).padStart(2, "0")}`);
  const res2 = E.analyze({ samplesText: lines.join("\n"), oel: 10, bayes: { draws: 500, burn: 100 } });
  const trend = res2.gate.items.find(i => i.key === "trend");
  truthy("trend item present", !!trend && trend.stat);
  if (trend && trend.stat) { close("Spearman rho", trend.stat.rho, sp.rho, 1e-9); close("Spearman p", trend.stat.p, sp.p, 1e-7); }
}

// ---- Lognormal summary: hand-worked values for a simple set ----
{
  // logs of these values: mean 0, sd 1 exactly: exp(-1), exp(0), exp(1)
  const vals = [Math.exp(-1), 1, Math.exp(1)];
  const res = E.analyze({ samplesText: vals.join("\n"), oel: 10, bayes: { draws: 2000, burn: 300 } });
  const s = res.summary;
  close("GM", s.gm, 1, 1e-9);
  close("GSD", s.gsd, Math.E, 1e-9);
  close("X95", s.x95, Math.exp(1.6448536269514722), 1e-9);
  close("UTL95,95 uses K(3)", s.x95UCL, Math.exp(N.kFactor(3)), 1e-9);
  close("GM CI upper", s.gmCI[1], Math.exp(N.qt(0.975, 2) / Math.sqrt(3)), 1e-9);
  close("GSD CI lower", s.gsdCI[0], Math.exp(Math.sqrt(2 / N.qchisq(0.975, 2))), 1e-9);
  close("AM", s.am, Math.exp(0.5), 1e-9);
  close("EF", s.ef, 1 - N.pnorm(Math.log(10)), 1e-9);
  // EF confidence limits are consistent with the tolerance limits: UCL on EF = 5% exactly when UTL = OEL
  const res2 = E.analyze({ samplesText: vals.join("\n"), oel: s.x95UCL, bayes: { draws: 500, burn: 100 } });
  close("EF UCL = 5% when OEL = UTL95,95", res2.summary.efUCL, 0.05, 1e-6);
  const res3 = E.analyze({ samplesText: vals.join("\n"), oel: s.x95LCL, bayes: { draws: 500, burn: 100 } });
  close("EF LCL = 5% when OEL = lower limit on X95", res3.summary.efLCL, 0.05, 1e-6);
}

// ---- Bayesian sampler: posterior agrees with the MLE for a large uncensored sample ----
{
  const rng = new N.Rng(7);
  const vals = [];
  for (let i = 0; i < 400; i++) vals.push(Math.exp(1 + 0.7 * rng.normal()));
  const text = vals.map(v => v.toFixed(5)).join("\n");
  const res = E.analyze({ samplesText: text, oel: 20, bayes: { draws: 4000, burn: 500 } });
  close("posterior GM ~ MLE GM", res.bayes.gm.median, res.summary.gm, 0.02);
  close("posterior GSD ~ MLE GSD", res.bayes.gsd.median, res.summary.gsd, 0.02);
  close("posterior X95 ~ MLE X95", res.bayes.x95.median, res.summary.x95, 0.03);
  truthy("band probabilities sum to 1", Math.abs(res.bayes.bandProbs.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  truthy("P(X95 > OEL) equals P(EF > 5%)", res.bayes.pOverOel === res.bayes.pEf5);
  // reproducible with the same seed
  const res2 = E.analyze({ samplesText: text, oel: 20, bayes: { draws: 4000, burn: 500 } });
  truthy("same seed, same posterior", res2.bayes.x95.median === res.bayes.x95.median);
}

// ---- Non-detect methods ----
{
  const text = "<1\n<1\n<2\n1.5\n2.2\n3\n4.5\n0.8\n<0.5";
  const d = E.parseSamples(text);
  const half = E.fitLognormal(d.rows, "half"), dl = E.fitLognormal(d.rows, "dl"), mle = E.fitLognormal(d.rows, "mle"), r = E.fitLognormal(d.rows, "ros");
  truthy("DL/2 lower than DL substitution", half.mu < dl.mu);
  truthy("ROS imputes below the DL", r.ros.imputed.every(v => v < 2) && r.ros.imputed.length === 4);
  truthy("MLE converged", mle.converged && mle.sigma > 0);
  truthy("ROS refuses interval data", E.ros(E.parseSamples("1-2\n3\n4").rows) === null);
}

// ---- SAE classification (OSHA single-sample rule) ----
{
  const res = E.analyze({ samplesText: "12\n8\n5", oel: 10, sae: { mode: "direct", saePct: 25 }, bayes: { draws: 500, burn: 100 } });
  const [a, b, c] = res.sae.perSample;
  truthy("12 with ±25% straddles the OEL", a.cls === "possible", JSON.stringify(a));
  truthy("8 with ±25% straddles the OEL", b.cls === "possible");
  truthy("5 with ±25% is compliant", c.cls === "compliant");
  const res2 = E.analyze({ samplesText: "14", oel: 10, sae: { mode: "direct", saePct: 25 }, bayes: { draws: 500, burn: 100 } });
  truthy("14 with ±25% is an overexposure", res2.sae.perSample[0].cls === "over");
  // The rule is Y ∓ SAE: 13 against an OEL of 10 gives 1.30 - 0.25 = 1.05, an overexposure.
  const res3 = E.analyze({ samplesText: "13\n1", oel: 10, sae: { mode: "direct", saePct: 25 }, bayes: { draws: 500, burn: 100 } });
  close("LCL is Y - SAE", res3.sae.perSample[0].lcl, 1.05, 1e-12);
  close("UCL is Y + SAE", res3.sae.perSample[0].ucl, 1.55, 1e-12);
  truthy("13 with ±25% is an overexposure", res3.sae.perSample[0].cls === "over");
  close("LCL is not shown below zero", res3.sae.perSample[1].lcl, 0, 1e-12);
  truthy("single sample overexposure is a no-go", res2.verdict.status === "nogo", res2.verdict.title);
  close("SAE from CVs", E.analyze({ samplesText: "1", oel: 10, sae: { mode: "cv", cvAnalytical: 0.08, cvSampling: 0.06 }, bayes: { draws: 200, burn: 50 } }).sae.sae, 1.6448536269514722 * 0.1, 1e-9);
}

// ---- Gatekeeper ----
{
  const sparse = "2.1,,2020-03-01\n3.4,,2021-04-01\n1.9,,2022-05-01\n4.0,,2023-06-01";
  const res = E.analyze({ samplesText: sparse, oel: 10, bayes: { draws: 200, burn: 50 } });
  truthy("one sample a year over four years fails the gate", res.gate.status === "fail" && !res.gate.allowed, res.gate.status);
  truthy("statistics withheld", res.verdict.status === "withheld" && !res.summary);
  const res2 = E.analyze({ samplesText: sparse, oel: 10, gateOverride: true, gateReason: "test", bayes: { draws: 200, burn: 50 } });
  truthy("override runs the statistics and records it", res2.gate.overridden && !!res2.summary && E.reportText(res2).includes("overridden"));
  const res3 = E.analyze({ samplesText: "1\n2\n3\n4\n5\n6", oel: 10, gate: { sameControls: "no" }, bayes: { draws: 200, burn: 50 } });
  truthy("a No answer fails the gate", res3.gate.status === "fail");
  const res4 = E.analyze({ samplesText: "1\n2\n3\n4\n5\n6", oel: 10, gate: { sameRate: "unknown" }, bayes: { draws: 200, burn: 50 } });
  truthy("an Unknown answer is a caution", res4.gate.status === "caution" && res4.gate.allowed);
  const res5 = E.analyze({ samplesText: "1.1\n1.2\n0.9\n1.0\n1.3\n40", oel: 100, bayes: { draws: 200, burn: 50 } });
  truthy("Grubbs flags the outlier", res5.gate.items.some(i => i.key === "outlier" && i.level === "warn"));
}

// ---- Verdict logic ----
{
  const low = E.analyze({ samplesText: "0.5\n0.6\n0.4\n0.55\n0.7\n0.45\n0.5\n0.6", oel: 10, bayes: { draws: 3000, burn: 500 } });
  truthy("well below the OEL is a go", low.verdict.status === "go" && low.summary.band.id === 1, low.verdict.title);
  const high = E.analyze({ samplesText: "8\n12\n15\n9\n20\n11\n14\n10", oel: 10, bayes: { draws: 3000, burn: 500 } });
  truthy("above the OEL is a no-go", high.verdict.status === "nogo" && high.summary.band.id === 4, high.verdict.title);
  const grey = E.analyze({ samplesText: "3\n5\n4\n6\n2.5\n4.5", oel: 10, bayes: { draws: 3000, burn: 500 } });
  truthy("gray zone needs more data", grey.verdict.status === "more", grey.verdict.title + " " + grey.bayes.pOverOel);
  truthy("verdict reasons mention the band", grey.verdict.reasons[0].includes("Category"));
  const prior = E.analyze({ samplesText: "3\n5\n4\n6\n2.5\n4.5", oel: 10, decision: { usePrior: true, prior: [0.1, 0.1, 0.1, 0.7] }, bayes: { draws: 3000, burn: 500 } });
  truthy("decision prior raises P(>OEL)", prior.bayes.pOverOelPrior > prior.bayes.pOverOel);
  truthy("report text is produced", E.reportText(low).includes("VERDICT") && E.reportText(low).includes("GO"));
}

// ---- Worker analysis ----
{
  const text = ["result,worker", "1,A", "1.2,A", "0.9,A", "4,B", "5,B", "4.5,B", "2,C", "2.2,C", "1.8,C"].join("\n");
  const res = E.analyze({ samplesText: text, oel: 50, bayes: { draws: 2000, burn: 300 } });
  const w = res.worker.anova;
  truthy("three workers", w.k === 3 && w.N === 9);
  truthy("between-worker variance dominates here", w.fracBetween > 0.8, String(w.fracBetween));
  truthy("R above 2", w.R > 2);
  truthy("Bayesian worker model ran", res.worker.bayes && res.worker.bayes.draws === 2000);
  // balanced one-way ANOVA by hand
  const logs = [[1, 1.2, 0.9], [4, 5, 4.5], [2, 2.2, 1.8]].map(g => g.map(Math.log));
  const gm = logs.map(g => g.reduce((a, b) => a + b, 0) / 3), grand = gm.reduce((a, b) => a + b, 0) / 3;
  const msb = 3 * gm.reduce((s, m) => s + (m - grand) ** 2, 0) / 2;
  const msw = logs.reduce((s, g, i) => s + g.reduce((t, v) => t + (v - gm[i]) ** 2, 0), 0) / 6;
  close("MSB", w.msb, msb, 1e-9); close("MSW", w.msw, msw, 1e-9);
  close("sigmaB^2", w.sigmaB ** 2, (msb - msw) / 3, 1e-9);
}

// ---- Parsing edge cases ----
{
  const d = E.parseSamples("Result\tWorker\tDate\n1.5\tW1\t01/02/2026\n< 0.2\tW2\t2026-01-03\n2 - 4\tW1\t2026-01-04\nabc\n>9\n0\n");
  truthy("header row with tabs", d.n === 4, JSON.stringify(d));
  truthy("bad lines reported", d.errors.length === 2, JSON.stringify(d.errors));
  truthy("US date parsed", d.rows[0].date && d.rows[0].date.toISOString().startsWith("2026-01-02"));
  truthy("range parsed", d.rows[2].type === "interval" && d.rows[2].lo === 2 && d.rows[2].hi === 4);
}

console.log(`${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
