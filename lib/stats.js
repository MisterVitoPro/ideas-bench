"use strict";

// Paired statistics for the bench harness: exact Wilcoxon signed-rank test,
// exact (sign-test) binomial test, and null-safe descriptive summaries.
// Dependency-free. Every function is pure and never fabricates a value for
// missing data -- inputs that cannot be used are dropped and counted, never
// silently zero-filled or interpolated.

const ZERO_EPS = 1e-9;
const TIE_EPS = 1e-9;

function isUsableNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function cleanNumbers(xs) {
  return (Array.isArray(xs) ? xs : []).filter(isUsableNumber);
}

// mean(xs) -> number | null
//
// Arithmetic mean of the usable (non-null, non-undefined, finite) entries.
// Drops unusable entries rather than treating them as 0. Returns null -- not
// NaN, not 0 -- when no usable entries remain, so callers can distinguish
// "no data" from "data averaging to zero".
function mean(xs) {
  const vals = cleanNumbers(xs);
  if (vals.length === 0) return null;
  return vals.reduce((sum, v) => sum + v, 0) / vals.length;
}

// median(xs) -> number | null
//
// Same null-safety contract as mean().
function median(xs) {
  const vals = cleanNumbers(xs).slice().sort((x, y) => x - y);
  if (vals.length === 0) return null;
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2 === 1) return vals[mid];
  return (vals[mid - 1] + vals[mid]) / 2;
}

// Pairwise-drops entries where either side is missing/non-numeric. This is
// the one null-handling rule shared by every paired function in this module:
// a pair is only usable when BOTH sides are usable numbers, so meanA/meanB/
// diffs all describe the exact same surviving subset.
function pairwiseDrop(pairsA, pairsB) {
  if (!Array.isArray(pairsA) || !Array.isArray(pairsB)) {
    throw new TypeError("pairsA and pairsB must be arrays");
  }
  if (pairsA.length !== pairsB.length) {
    throw new RangeError(
      `pairsA and pairsB must have the same length (got ${pairsA.length} and ${pairsB.length})`
    );
  }

  const a = [];
  const b = [];
  const diffs = [];
  let dropped = 0;

  for (let i = 0; i < pairsA.length; i++) {
    const av = pairsA[i];
    const bv = pairsB[i];
    if (!isUsableNumber(av) || !isUsableNumber(bv)) {
      dropped += 1;
      continue;
    }
    a.push(av);
    b.push(bv);
    diffs.push(av - bv);
  }

  return { a, b, diffs, dropped };
}

// Assigns ranks (1-based) to a set of non-negative magnitudes, averaging
// ranks across ties (the standard "average rank" method: e.g. two entries
// tied for ranks 1-2 both get rank 1.5). Returns an array parallel to the
// input order.
function averageRanks(magnitudes) {
  const n = magnitudes.length;
  const order = magnitudes.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const ranks = new Array(n);

  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && Math.abs(order[end + 1].v - order[start].v) < TIE_EPS) {
      end += 1;
    }
    // Positions start..end (0-based) occupy 1-based ranks (start+1)..(end+1).
    const avgRank = (start + 1 + end + 1) / 2;
    for (let k = start; k <= end; k++) {
      ranks[order[k].i] = avgRank;
    }
    start = end + 1;
  }

  return ranks;
}

// Exact null distribution of the Wilcoxon positive-signed-rank statistic
// (W+) by dynamic-programming subset-sum enumeration: under H0, each rank is
// independently assigned to the positive or negative sum with probability
// 0.5, so W+ is the sum of a random subset of the n ranks. Counting subsets
// by achieved sum for all 2^n sign assignments gives the exact distribution
// -- correct with or without ties, since tied items are still counted as
// distinct items even when their (averaged) rank values coincide. Ranks are
// doubled first so tie-averaged half-integer ranks (e.g. 1.5) become
// integers, keeping the DP array indices whole numbers.
function exactSignedRankP(ranks, observedWPos) {
  const n = ranks.length;
  const scaled = ranks.map((r) => Math.round(r * 2));
  const total = scaled.reduce((sum, r) => sum + r, 0);
  const wScaled = Math.round(observedWPos * 2);

  const counts = new Array(total + 1).fill(0);
  counts[0] = 1;
  for (const r of scaled) {
    for (let s = total; s >= r; s--) {
      if (counts[s - r] !== 0) counts[s] += counts[s - r];
    }
  }

  let countGE = 0;
  let countLE = 0;
  for (let s = 0; s <= total; s++) {
    if (s >= wScaled) countGE += counts[s];
    if (s <= wScaled) countLE += counts[s];
  }

  const denom = Math.pow(2, n);
  const pUpper = countGE / denom;
  const pLower = countLE / denom;
  return Math.min(1, 2 * Math.min(pUpper, pLower));
}

// wilcoxonSignedRank(pairsA, pairsB) -> {n, w, p, medianDiff, dropped, zeros}
//
// Exact (not normal-approximated) two-sided Wilcoxon signed-rank test on the
// paired differences A - B.
//
// Null handling: pairs where either side is missing are dropped pairwise
// (see pairwiseDrop) and counted in `dropped`.
//
// Zero handling: per standard Wilcoxon signed-rank practice, pairs whose
// difference is (within floating-point tolerance of) zero carry no sign
// information and are dropped from the rank test itself; the count is
// reported in `zeros`. medianDiff, however, is computed over ALL surviving
// non-null differences including zeros, since it is a plain descriptive
// statistic, not the rank-test statistic.
//
// `n` is the count of nonzero differences actually used by the rank test
// (i.e. after both null-drop and zero-drop). `w` is W+, the sum of the
// signed ranks of the positive differences. When n=0 (no nonzero, non-null
// differences survive) this is a documented degenerate case: w=0, p=1 --
// there is no evidence of a directional effect because there is no
// discordant pair to measure one from.
function wilcoxonSignedRank(pairsA, pairsB) {
  const { diffs, dropped } = pairwiseDrop(pairsA, pairsB);
  const medianDiff = median(diffs);

  const nonzero = diffs.filter((d) => Math.abs(d) > ZERO_EPS);
  const zeros = diffs.length - nonzero.length;
  const n = nonzero.length;

  if (n === 0) {
    return { n: 0, w: 0, p: 1, medianDiff, dropped, zeros };
  }

  const ranks = averageRanks(nonzero.map((d) => Math.abs(d)));
  let wPos = 0;
  for (let i = 0; i < n; i++) {
    if (nonzero[i] > 0) wPos += ranks[i];
  }

  const p = exactSignedRankP(ranks, wPos);

  return { n, w: wPos, p, medianDiff, dropped, zeros };
}

function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

// exactBinomial(wins, losses) -> {p}
//
// Exact two-sided sign-test p-value for `wins + losses` discordant pairs
// under H0: P(win) = P(loss) = 0.5. Doubles the smaller exact tail
// probability of the symmetric Binomial(n, 0.5) distribution and caps at 1:
//   p = min(1, 2 * P(X <= min(wins, losses)))
// This is exact for every n (no normal approximation at any sample size).
// wins=losses=0 (no discordant pairs) is a documented degenerate case: there
// is nothing to test, so p=1.
function exactBinomial(wins, losses) {
  const n = wins + losses;
  if (n === 0) return { p: 1 };

  const k = Math.min(wins, losses);
  let cumulative = 0;
  for (let i = 0; i <= k; i++) {
    cumulative += binomialCoefficient(n, i);
  }
  const p = Math.min(1, (2 * cumulative) / Math.pow(2, n));
  return { p };
}

// summarize(pairsA, pairsB) -> {n, meanA, meanB, medianDiff, wilcoxon_p, dropped}
//
// Null-safe paired summary. `n` and `dropped` describe the pairwise-drop
// step shared by meanA/meanB/medianDiff (see pairwiseDrop): n is the count
// of pairs where both sides were usable numbers, dropped is the count where
// either side was missing. medianDiff and wilcoxon_p come from
// wilcoxonSignedRank, which additionally drops zero differences from its
// own rank-test n (see that function's doc comment) without affecting the n
// reported here.
function summarize(pairsA, pairsB) {
  const { a, b, dropped } = pairwiseDrop(pairsA, pairsB);
  const wilcoxon = wilcoxonSignedRank(pairsA, pairsB);

  return {
    n: a.length,
    meanA: mean(a),
    meanB: mean(b),
    medianDiff: wilcoxon.medianDiff,
    wilcoxon_p: wilcoxon.p,
    dropped,
  };
}

module.exports = {
  mean,
  median,
  wilcoxonSignedRank,
  exactBinomial,
  summarize,
};
