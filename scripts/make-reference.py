# Writes tests/reference.json: values from SciPy that tests/check.mjs compares the engine with.
# Run: python3 scripts/make-reference.py   (needs scipy and numpy)
import json, math
import numpy as np
from scipy import stats
from scipy.stats import CensoredData

out = {}
out["pnorm"] = [[x, float(stats.norm.cdf(x))] for x in [-8, -3.5, -1.96, -0.5, 0, 0.3, 1.644853626951, 2.5, 6, 9]]
out["qnorm"] = [[p, float(stats.norm.ppf(p))] for p in [1e-10, 1e-6, 0.001, 0.025, 0.05, 0.2, 0.5, 0.7, 0.95, 0.975, 0.999, 1-1e-9]]
out["qt"] = [[p, df, float(stats.t.ppf(p, df))] for p, df in [(0.95, 1), (0.975, 2), (0.95, 4), (0.975, 9), (0.95, 29), (0.05, 11), (0.995, 100)]]
out["pt"] = [[t, df, float(stats.t.cdf(t, df))] for t, df in [(2.1, 5), (-1.5, 3), (0.7, 40), (4, 2)]]
out["qchisq"] = [[p, df, float(stats.chi2.ppf(p, df))] for p, df in [(0.05, 1), (0.95, 2), (0.025, 9), (0.975, 9), (0.05, 29), (0.95, 120)]]
out["pbeta"] = [[x, a, b, float(stats.beta.cdf(x, a, b))] for x, a, b in [(0.3, 2, 5), (0.8, 0.5, 0.5), (0.1, 10, 2), (0.5, 3.5, 7.25)]]
out["lgamma"] = [[x, float(math.lgamma(x))] for x in [0.5, 1, 2.5, 10, 50.5, 171]]
out["pnt"] = [[t, df, d, float(stats.nct.cdf(t, df, d))] for t, df, d in [(2.5, 4, 1.5), (0.8, 9, 3.678), (-1, 6, 0.5), (5.2, 2, 2.85), (3.0, 29, 9.0), (1.2, 100, 1.0)]]
out["qnt"] = [[p, df, d, float(stats.nct.ppf(p, df, d))] for p, df, d in [(0.95, 4, 3.678), (0.95, 9, 5.2), (0.05, 11, 2.0), (0.5, 3, 1.0)]]
# One-sided tolerance factors K(n; p=0.95, conf=0.95)
out["kFactor"] = []
for n in [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 50, 100]:
    d = stats.norm.ppf(0.95) * math.sqrt(n)
    out["kFactor"].append([n, float(stats.nct.ppf(0.95, n - 1, d) / math.sqrt(n))])
# Shapiro-Wilk
sw_sets = {
    "a": [148, 154, 158, 160, 161, 162, 166, 170, 182, 195, 236],
    "b": [0.22, 0.31, 0.5, 0.56, 0.6, 0.72, 0.8, 1.05, 1.1, 1.3, 1.5, 2.1, 2.4, 3.7, 5.2, 8.9],
    "c": [1.2, 3.4, 2.2],
    "d": [10, 12, 9, 15, 11],
    "e": list(np.round(np.random.default_rng(1).lognormal(1.0, 0.8, 40), 4)),
    "f": list(np.round(np.random.default_rng(2).normal(50, 10, 25), 3)),
}
out["shapiro"] = []
for k, v in sw_sets.items():
    w, p = stats.shapiro(v)
    out["shapiro"].append({"name": k, "x": [float(t) for t in v], "W": float(w), "p": float(p)})
# Censored lognormal MLE (log-scale normal fit) with left-censored and interval data
cens = {"uncensored": [0.9, 1.4, 2.2, 3.1, 0.55, 4.8, 1.0, 2.6], "left": [0.2, 0.2, 0.5], "interval_lo": [0.3], "interval_hi": [0.8], "right": [6.0]}
logs = CensoredData(uncensored=np.log(cens["uncensored"]), left=np.log(cens["left"]), right=np.log(cens["right"]), interval=np.column_stack([np.log(cens["interval_lo"]), np.log(cens["interval_hi"])]))
mu, sigma = stats.norm.fit(logs)
out["censoredMLE"] = {"data": cens, "mu": float(mu), "sigma": float(sigma)}
plain = [0.9, 1.4, 2.2, 3.1, 0.55, 4.8, 1.0, 2.6, 0.12, 0.33]
mu2, sigma2 = stats.norm.fit(np.log(plain))
out["plainMLE"] = {"data": plain, "mu": float(mu2), "sigma": float(sigma2)}
# Welch t-test on logs, F test and Spearman
A = [1.2, 2.3, 0.9, 3.1, 1.7, 2.2]; B = [0.4, 0.8, 1.1, 0.6, 0.5, 0.9, 0.7]
t, p = stats.ttest_ind(np.log(A), np.log(B), equal_var=False)
out["welch"] = {"A": A, "B": B, "t": float(t), "p": float(p)}
rho, prho = stats.spearmanr([1, 2, 3, 4, 5, 6, 7, 8], [2.1, 1.9, 2.6, 2.4, 3.3, 3.0, 3.9, 3.7])
out["spearman"] = {"x": [1, 2, 3, 4, 5, 6, 7, 8], "y": [2.1, 1.9, 2.6, 2.4, 3.3, 3.0, 3.9, 3.7], "rho": float(rho), "p": float(prho)}
with open("tests/reference.json", "w") as f:
    json.dump(out, f, indent=1)
print("wrote tests/reference.json")
