// Numerical routines for the OEMS Exposure Statistics Tool. Pure functions, no DOM.
// Distributions (normal, Student t, chi-square, noncentral t, beta), the Shapiro-Wilk test
// (Royston 1995, AS R94), a Nelder-Mead optimiser, a bisection root finder and a seedable
// random number generator for the Bayesian sampler. Checked against SciPy in tests/check.mjs.

export const SQRT2PI = Math.sqrt(2 * Math.PI);
export const LN_SQRT_PI = 0.57236494292470008707; // ln(sqrt(pi))

// ---------- Normal distribution ----------

/** Standard normal density. */
export function dnorm(x) { return Math.exp(-0.5 * x * x) / SQRT2PI; }

/** Standard normal cumulative distribution (Hart 1968 as given by West 2005; ~1e-15). */
export function pnorm(x) {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      c = e * ((((((3.52624965998911e-02 * z + 0.700383064443688) * z + 6.37396220353165) * z + 33.912866078383) * z + 112.079291497871) * z + 221.213596169931) * z + 220.206867912376);
      c /= (((((((8.83883476483184e-02 * z + 1.75566716318264) * z + 16.064177579207) * z + 86.7807322029461) * z + 296.564248779674) * z + 637.333633378831) * z + 793.826512519948) * z + 440.413735824752);
    } else {
      c = e / (z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))))) / 2.506628274631;
    }
  }
  return x <= 0 ? c : 1 - c;
}

/** Standard normal quantile (Acklam's algorithm with one Newton refinement). */
export function qnorm(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Newton refinement using the accurate CDF
  for (let i = 0; i < 2; i++) {
    const e = pnorm(x) - p;
    const u = e / dnorm(x);
    x = x - u / (1 + x * u / 2);
  }
  return x;
}

// ---------- Gamma and beta functions ----------

/** ln Gamma(x) (Lanczos approximation, g = 7). */
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = coef[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coef[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b). */
export function pbeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Regularised lower incomplete gamma P(a, x). */
export function pgammaInc(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 1; n <= 500; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  // continued fraction for Q
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

// ---------- Student t and chi-square ----------

/** Student t cumulative distribution with df degrees of freedom. */
export function pt(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const p = 0.5 * pbeta(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

/** Student t quantile. */
export function qt(p, df) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  return bisect(t => pt(t, df) - p, -1e4, 1e4, 1e-12);
}

/** Chi-square cumulative distribution. */
export function pchisq(x, df) { return x <= 0 ? 0 : pgammaInc(df / 2, x / 2); }

/** Chi-square quantile. */
export function qchisq(p, df) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return bisect(x => pchisq(x, df) - p, 0, Math.max(1e4, df * 50), 1e-11);
}

/** F distribution cumulative distribution. */
export function pf(f, df1, df2) {
  if (f <= 0) return 0;
  return pbeta(df1 * f / (df1 * f + df2), df1 / 2, df2 / 2);
}

// ---------- Noncentral t (AS 243, Lenth 1989; the version in R's pnt.c) ----------

/** Cumulative distribution of the noncentral t with df degrees of freedom and noncentrality delta. */
export function pnt(t, df, delta) {
  if (df <= 0) return NaN;
  if (delta === 0) return pt(t, df);
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  let negdel = false, tt = t, del = delta;
  if (t < 0) { negdel = true; tt = -t; del = -delta; }
  if (df > 4e5 || del * del > 2 * Math.LN2 * 1021) {
    // normal approximation (Abramowitz & Stegun 26.7.10)
    const s = 1 / (4 * df);
    const z = (tt * (1 - s) - del) / Math.sqrt(1 + tt * tt * 2 * s);
    const v = pnorm(z);
    return negdel ? 1 - v : v;
  }
  const x = tt * tt / (tt * tt + df);
  let tnc;
  if (x > 0) {
    const lambda = del * del;
    let p = 0.5 * Math.exp(-0.5 * lambda);
    let q = Math.sqrt(2 / Math.PI) * p * del;
    let s = 0.5 - p;
    if (s < 1e-7) s = -0.5 * Math.expm1(-0.5 * lambda);
    let a = 0.5;
    const b = 0.5 * df;
    const rxb = Math.pow(1 - x, b);
    const albeta = LN_SQRT_PI + lgamma(b) - lgamma(0.5 + b);
    let xodd = pbeta(x, a, b);
    let godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta);
    tnc = b * x;
    let xeven = tnc < 2.2e-16 ? tnc : 1 - rxb;
    let geven = tnc * rxb;
    tnc = p * xodd + q * xeven;
    const errmax = 1e-12, itrmax = 1000;
    for (let it = 1; it <= itrmax; it++) {
      a += 1;
      xodd -= godd;
      xeven -= geven;
      godd *= x * (a + b - 1) / a;
      geven *= x * (a + b - 0.5) / (a + 0.5);
      p *= lambda / (2 * it);
      q *= lambda / (2 * it + 1);
      tnc += p * xodd + q * xeven;
      s -= p;
      if (s < -1e-10) break;
      if (s <= 0 && it > 1) break;
      const errbd = 2 * s * (xodd - godd);
      if (Math.abs(errbd) < errmax) break;
    }
  } else {
    tnc = 0;
  }
  tnc += pnorm(-del);
  if (tnc > 1 - 1e-10) tnc = 1;
  const v = Math.min(Math.max(tnc, 0), 1);
  return negdel ? 1 - v : v;
}

/** Quantile of the noncentral t. */
export function qnt(p, df, delta) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = delta - 50 - 10 * Math.sqrt(1 + delta * delta), hi = delta + 50 + 10 * Math.sqrt(1 + delta * delta);
  while (pnt(lo, df, delta) > p) lo *= 2;
  while (pnt(hi, df, delta) < p) hi *= 2;
  return bisect(t => pnt(t, df, delta) - p, lo, hi, 1e-10);
}

/**
 * One-sided tolerance factor K for a normal sample of size n: the lower / upper tolerance
 * bound mean ± K·s covers proportion p with confidence conf. Exact (noncentral t).
 */
export function kFactor(n, p = 0.95, conf = 0.95) {
  if (n < 2) return NaN;
  const delta = qnorm(p) * Math.sqrt(n);
  return qnt(conf, n - 1, delta) / Math.sqrt(n);
}

// ---------- Root finding and optimisation ----------

/** Bisection for f(x) = 0 on [lo, hi] where f(lo) and f(hi) have opposite signs. */
export function bisect(f, lo, hi, tol = 1e-10, maxit = 300) {
  let flo = f(lo), fhi = f(hi);
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo * fhi > 0) {
    // try to expand once
    throw new Error("bisect: root not bracketed");
  }
  for (let i = 0; i < maxit; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm === 0 || (hi - lo) / 2 < tol) return mid;
    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
  }
  return 0.5 * (lo + hi);
}

/** Nelder-Mead minimisation of f over a vector. Returns { x, fx, iterations }. */
export function nelderMead(f, x0, { step = 0.5, tol = 1e-10, maxit = 4000 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += (p[i] !== 0 ? Math.abs(p[i]) * step : step);
    simplex.push(p);
  }
  let values = simplex.map(f);
  let it = 0;
  const order = () => {
    const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = idx.map(i => simplex[i]);
    values = idx.map(i => values[i]);
  };
  for (; it < maxit; it++) {
    order();
    if (Math.abs(values[n] - values[0]) < tol * (1 + Math.abs(values[0])) && it > 20) {
      let spread = 0;
      for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) spread = Math.max(spread, Math.abs(simplex[i][j] - simplex[0][j]));
      if (spread < 1e-8) break;
    }
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const reflect = centroid.map((c, j) => c + (c - worst[j]));
    const fr = f(reflect);
    if (fr < values[0]) {
      const expand = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(expand);
      if (fe < fr) { simplex[n] = expand; values[n] = fe; } else { simplex[n] = reflect; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflect; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const contract = centroid.map((c, j) => outside ? c + 0.5 * (reflect[j] - c) : c + 0.5 * (worst[j] - c));
      const fc = f(contract);
      if (fc < (outside ? fr : values[n])) { simplex[n] = contract; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  order();
  return { x: simplex[0], fx: values[0], iterations: it };
}

// ---------- Shapiro-Wilk W test (Royston 1995, Applied Statistics algorithm AS R94) ----------

function poly(cc, nord, x) {
  let ret = cc[0];
  if (nord > 1) {
    let p = x * cc[nord - 1];
    for (let j = nord - 2; j > 0; j--) p = (p + cc[j]) * x;
    ret += p;
  }
  return ret;
}

/**
 * Shapiro-Wilk test of normality. x: numeric array (any order), 3 <= n <= 5000.
 * Returns { W, p } (p is the upper-tail p-value; small p rejects normality).
 */
export function shapiroWilk(xin) {
  const x = xin.slice().sort((a, b) => a - b);
  const n = x.length;
  if (n < 3) return { W: NaN, p: NaN, error: "n < 3" };
  if (n > 5000) return { W: NaN, p: NaN, error: "n > 5000" };
  const nn2 = Math.floor(n / 2);
  const a = new Array(nn2 + 1).fill(0); // 1-based
  const small = 1e-19;
  const g = [-2.273, 0.459];
  const c1 = [0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056];
  const c2 = [0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633];
  const c3 = [0.544, -0.39978, 0.025054, -6.714e-4];
  const c4 = [1.3822, -0.77857, 0.062767, -0.0020322];
  const c5 = [-1.5861, -0.31082, -0.083751, 0.0038915];
  const c6 = [-0.4803, -0.082676, 0.0030302];
  const an = n;
  if (n === 3) {
    a[1] = Math.SQRT1_2;
  } else {
    const an25 = an + 0.25;
    let summ2 = 0;
    const m = new Array(nn2 + 1).fill(0);
    for (let i = 1; i <= nn2; i++) {
      m[i] = qnorm((i - 0.375) / an25);
      summ2 += m[i] * m[i];
    }
    summ2 *= 2;
    const ssumm2 = Math.sqrt(summ2);
    const rsn = 1 / Math.sqrt(an);
    const a1 = poly(c1, 6, rsn) - m[1] / ssumm2;
    let i1, fac;
    if (n > 5) {
      i1 = 3;
      const a2 = -m[2] / ssumm2 + poly(c2, 6, rsn);
      fac = Math.sqrt((summ2 - 2 * m[1] * m[1] - 2 * m[2] * m[2]) / (1 - 2 * a1 * a1 - 2 * a2 * a2));
      a[2] = a2;
    } else {
      i1 = 2;
      fac = Math.sqrt((summ2 - 2 * m[1] * m[1]) / (1 - 2 * a1 * a1));
    }
    a[1] = a1;
    for (let i = i1; i <= nn2; i++) a[i] = -m[i] / fac;
  }
  const range = x[n - 1] - x[0];
  if (range < small) return { W: 1, p: 1, error: "all values equal" };
  let xx = x[0] / range, sx = xx, sa = -a[1];
  for (let i = 1, j = n - 1; i < n; j--) {
    const xi = x[i] / range;
    sx += xi;
    i++;
    if (i !== j) sa += Math.sign(i - j) * a[Math.min(i, j)];
    xx = xi;
  }
  sa /= n; sx /= n;
  let ssa = 0, ssx = 0, sax = 0;
  for (let i = 0, j = n - 1; i < n; i++, j--) {
    const asa = i !== j ? Math.sign(i - j) * a[1 + Math.min(i, j)] - sa : -sa;
    const xsx = x[i] / range - sx;
    ssa += asa * asa; ssx += xsx * xsx; sax += asa * xsx;
  }
  const ssassx = Math.sqrt(ssa * ssx);
  const w1 = (ssassx - sax) * (ssassx + sax) / (ssa * ssx);
  const W = 1 - w1;
  if (n === 3) {
    const pi6 = 1.90985931710274, stqr = 1.04719755119660;
    let pw = pi6 * (Math.asin(Math.sqrt(W)) - stqr);
    if (pw < 0) pw = 0;
    return { W, p: pw };
  }
  const y = Math.log(w1);
  const lnn = Math.log(an);
  let mm, s, yy = y;
  if (n <= 11) {
    const gamma = poly(g, 2, an);
    if (y >= gamma) return { W, p: 1e-99 };
    yy = -Math.log(gamma - y);
    mm = poly(c3, 4, an);
    s = Math.exp(poly(c4, 4, an));
  } else {
    mm = poly(c5, 4, lnn);
    s = Math.exp(poly(c6, 3, lnn));
  }
  const p = 1 - pnorm((yy - mm) / s);
  return { W, p };
}

// ---------- Random numbers (seedable, so a result can be reproduced) ----------

/** Seedable PRNG (mulberry32) with normal, gamma and truncated-normal draws. */
export class Rng {
  constructor(seed = 20261113) {
    this.s = seed >>> 0;
    this.spare = null;
  }
  uniform() {
    let t = (this.s += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal() {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    let u, v, s;
    do { u = this.uniform() * 2 - 1; v = this.uniform() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this.spare = v * m;
    return u * m;
  }
  /** Gamma(shape, 1) by Marsaglia & Tsang (with the boost for shape < 1). */
  gamma(shape) {
    if (shape < 1) {
      const u = this.uniform();
      return this.gamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  /** Normal(mean, sd) truncated to [lo, hi] by inverse CDF (robust to tail truncation). */
  truncNormal(mean, sd, lo, hi) {
    const a = Number.isFinite(lo) ? pnorm((lo - mean) / sd) : 0;
    const b = Number.isFinite(hi) ? pnorm((hi - mean) / sd) : 1;
    if (b - a < 1e-12) {
      // deep in a tail: fall back to the nearer bound plus a small offset
      if (Number.isFinite(lo) && !Number.isFinite(hi)) return lo + sd * 0.1 * this.uniform();
      if (Number.isFinite(hi) && !Number.isFinite(lo)) return hi - sd * 0.1 * this.uniform();
      return lo + (hi - lo) * this.uniform();
    }
    const u = a + (b - a) * this.uniform();
    return mean + sd * qnorm(Math.min(Math.max(u, 1e-15), 1 - 1e-15));
  }
}

// ---------- Small helpers ----------

export function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
export function variance(a) {
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
}
export function sd(a) { return Math.sqrt(variance(a)); }
export function quantile(sorted, p) {
  // Hazen plotting position (type 5), as in most IH tools
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = n * p + 0.5;
  if (h <= 1) return sorted[0];
  if (h >= n) return sorted[n - 1];
  const i = Math.floor(h);
  return sorted[i - 1] + (h - i) * (sorted[i] - sorted[i - 1]);
}
export function median(a) { const s = a.slice().sort((x, y) => x - y); return quantile(s, 0.5); }

/** Rank with ties averaged. */
export function ranks(a) {
  const idx = a.map((v, i) => i).sort((i, j) => a[i] - a[j]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}
