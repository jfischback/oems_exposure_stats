# OEMS Exposure Statistics Tool

A web tool that walks a similar exposure group's (SEG's) sample results from a data-quality check through sampling and analytical error (SAE), confidence limits, the 95th percentile with its UCL / UTL, the exceedance fraction and Bayesian decision analysis to a plain-language compliance call against the OEL and the action level. It covers what IHSTAT, IHSTAT-Bayes, IHDA and Expostats each do in part, in one place, and can be used on its own or as part of the OEMS risk assessment workflow.

Plain HTML, CSS and JavaScript (ES modules) with no build step. Same theme and disclaimer gate as the other OEMS calculators (`oems_ventilation`, `oems_noise`, `oems_radiation`, `oems_conversions`). Deploy as a static site (on Vercel, leave the framework preset as "Other"); it is one calculator, so it sits at the root of its own subdomain. Nothing entered leaves the browser.

## Files

- `index.html` – the page: 01 Agent and limits, 02 Sample results (with the non-detect method and the SAE inputs), 03 Data quality check (the gatekeeper), 04 Verdict (the stoplight strip and the reasons), 05 Statistics, 06 Graphs, 07 Sampling and analytical error, 08 Between / within worker, 09 Comparison, 10 Decision settings, 11 Report, 12 Method. The dark results panel on the right stays on screen.
- `engine.js` – the analysis. `analyze(inputs)` is pure and is what the page and the tests call. Parsing, the gatekeeper, the SAE rule, censored lognormal fits, frequentist and Bayesian summaries, worker variance, group comparison, the verdict and the report text.
- `numeric.js` – normal, t, chi-square, F, beta and noncentral t distributions; the one-sided tolerance factor; Shapiro-Wilk (Royston, AS R94); Nelder-Mead; a seedable random number generator with gamma and truncated-normal draws.
- `charts.js` – inline SVG: the stoplight strip, band probabilities, sequence plot, fitted distribution, lognormal probability plot, posterior of the 95th percentile, per-sample SAE limits, results by worker, group comparison.
- `app.js` – connects the form to the engine, autosaves the form in the browser, copy / download / print.
- `style.css`, `disclaimer.css`, `disclaimer.js` – the OEMS theme and first-visit disclaimer gate.
- `tests/check.mjs` – checks the engine (see Checking); `tests/reference.json` holds SciPy values written by `scripts/make-reference.py`.

## Entering data

One sample per line. The result comes first; after it, separated by commas (or tabs, pasted from a spreadsheet), a worker ID, a date (`YYYY-MM-DD` or `MM/DD/YYYY`), a group label and a note. A header row such as `result,worker,date,group` is optional.

- `<0.05` a non-detect: below the detection limit 0.05
- `>10` above the method's range
- `0.5-2` a range (for example a result reported between two values)

Worker IDs unlock the between- and within-worker analysis, dates unlock the time span and trend checks, and two group labels (for example `before` / `after`) unlock the comparison.

## What it does, in order

1. **Gatekeeper.** Seven yes / no / unknown questions (same task, same controls, similar production rate, same method, comparable durations, spread over days, no change in the period) plus automatic checks: sample count, share of censored results, time span (one sample a year over four years fails), a Spearman trend test on dated results, Grubbs' outlier test on the log scale, and whether worker IDs allow a homogeneity check. A "No" or a failed check withholds the statistics; the assessor can override, and the report records that.
2. **Sampling and analytical error.** The OSHA single-sample rule: with the result as a fraction of the OEL (Y) and SAE = 1.645 × √(CV<sub>analytical</sub>² + CV<sub>sampling</sub>²), the limits are Y − SAE and Y + SAE. LCL > 1 is an overexposure, UCL < 1 compliance, otherwise a possible overexposure. The SAE can also be entered directly (the NIOSH ±25% accuracy criterion).
3. **Lognormal fit.** Non-detects, above-range values and ranges by censored maximum likelihood (the default), robust ROS (Helsel), or substitution (DL/2, DL/√2, DL). Then GM and GSD with 95% confidence intervals (t and chi-square), the arithmetic mean with Cox's confidence limits, the 95th percentile with the exact one-sided tolerance factor K from the noncentral t (UTL<sub>95,95</sub> and the lower 95% limit), and the exceedance fraction with confidence limits from the noncentral t (the UCL on the exceedance fraction is 5% exactly when the UTL<sub>95,95</sub> equals the OEL).
4. **Goodness of fit.** Shapiro-Wilk W on the log scale and on the arithmetic scale, the probability-plot correlation, and the Q-Q plot. The better-fitting distribution is named; when neither fits, the non-parametric view is the fallback.
5. **Bayesian analysis.** A Gibbs sampler with data augmentation for censored values. Flat prior on the log GM and a uniform prior on the log GSD up to GSD 10, as in Expostats. It gives 90% credible intervals for GM, GSD, AM and the 95th percentile, the overexposure risk P(X<sub>95</sub> > OEL) (equivalently, the probability that more than 5% of exposures exceed the OEL), P(X<sub>95</sub> > action level), P(AM > OEL), and the probability of each AIHA category (< 10%, 10–50%, 50–100%, > 100% of the OEL). A decision prior over the four categories can be applied, IHSTAT-Bayes style, as weights relative to equal belief. With one sample a prior on the GSD (default 2.5) stands in for the spread.
6. **Workers.** One-way random-effects ANOVA on the log results: between- and within-worker GSD, the share of variance between workers, R (the ratio of the 97.5th to the 2.5th percentile of worker mean exposures), the probability that a random worker's own 95th percentile exceeds the OEL, and Rappaport's θ (the probability that a random worker's mean exceeds the OEL). The same model is fitted by Gibbs sampling.
7. **Comparison.** Two groups: Welch's t-test on the logs (ratio of GMs with CI), an F-test on the GSDs, and the Bayesian probability that the second group's GM, 95th percentile and AM are lower than the first's, with a credible interval on the ratio of 95th percentiles.
8. **Non-parametric.** Median, Hazen 95th percentile, count above the OEL and the action level with an exact binomial CI, and the confidence that the sample maximum is at or above the true 95th percentile (59 samples give 95%).
9. **Verdict.** The stoplight strip shows the 95th percentile as a fraction of the OEL on AIHA's four bands, with the bar from its lower 95% limit to its UTL<sub>95,95</sub> and the posterior probability of each band. Go when the overexposure risk is below the go threshold (default 5%, which matches "95% confident the 95th percentile is below the OEL"); no-go when it is at or above the no-go threshold (default 30%, Expostats' threshold) or the point estimate exceeds the OEL; otherwise the gray zone: needs more data, or more control. The action level is judged the same way.

The report (copy, .txt, .json, .csv of the data, print / PDF) carries the inputs, the data-quality result, the statistics and the verdict with its reasons.

## Checking

```bash
node tests/check.mjs
```

`tests/check.mjs` compares the distributions, the noncentral t, the tolerance factors, Shapiro-Wilk, the censored MLE, Welch's t-test and Spearman's correlation with SciPy values in `tests/reference.json`, the tolerance factors with published tables, the lognormal summary with hand-worked values, and checks the Bayesian sampler against the MLE on a large sample, the non-detect methods, the SAE rule, the gatekeeper, the verdict logic and the worker ANOVA. To regenerate the SciPy values:

```bash
python3 scripts/make-reference.py
```

## Changing a rule

The band edges, the default thresholds and the default priors are at the top of `engine.js` (`DEFAULTS`, `BANDS`). The gatekeeper questions and automatic checks are in `gatekeeper()`; the verdict wording in `verdict()`; the report in `reportText()`.

This tool supports the evaluator's professional judgement and does not replace it.
