"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const { mean, median, wilcoxonSignedRank, exactBinomial, summarize } = require("../lib/stats");

// ---------------------------------------------------------------------------
// mean / median: null-safe descriptive stats
// ---------------------------------------------------------------------------

test("mean computes the arithmetic mean of a plain numeric array", () => {
  assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
});

test("mean drops null and undefined entries rather than fabricating values", () => {
  assert.strictEqual(mean([1, 2, null, 3, undefined]), 2);
});

test("mean of an empty or all-null array is null, never a fabricated 0", () => {
  assert.strictEqual(mean([]), null);
  assert.strictEqual(mean([null, null, undefined]), null);
});

test("median computes the middle value for odd-length arrays", () => {
  assert.strictEqual(median([5, 1, 3]), 3);
});

test("median averages the two middle values for even-length arrays", () => {
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});

test("median drops null entries and returns null when nothing is left", () => {
  assert.strictEqual(median([null, 4, null, 2]), 3);
  assert.strictEqual(median([null, undefined]), null);
});

// ---------------------------------------------------------------------------
// wilcoxonSignedRank: validated against a published worked example.
//
// Source: Penn State University, STAT 415, Lesson 20.2 "The Wilcoxon Signed
// Rank Test for a Median" (https://online.stat.psu.edu/stat415/lesson/20/20.2)
// -- the "pygmy sunfish" example. Ten sunfish lengths are tested against a
// hypothesized median of 3.7 cm:
//   x = [5.0, 3.9, 5.2, 5.5, 2.8, 6.1, 6.4, 2.6, 1.7, 4.3]
// A one-sample test against a constant is the paired test of x against a
// constant series, so pairsB is 3.7 repeated. The textbook reports the
// positive-signed-rank statistic W = 40 and a two-sided exact p-value of
// 2 x 0.116 = 0.232 (n = 10, no ties, no zero differences).
// ---------------------------------------------------------------------------

test("wilcoxonSignedRank matches the published pygmy-sunfish worked example (PSU STAT 415, 20.2)", () => {
  const lengths = [5.0, 3.9, 5.2, 5.5, 2.8, 6.1, 6.4, 2.6, 1.7, 4.3];
  const hypothesizedMedian = new Array(lengths.length).fill(3.7);

  const result = wilcoxonSignedRank(lengths, hypothesizedMedian);

  assert.strictEqual(result.n, 10, "no zero differences, so n stays at 10");
  assert.strictEqual(result.dropped, 0);
  assert.strictEqual(result.zeros, 0);
  assert.strictEqual(result.w, 40, "published W statistic (sum of positive signed ranks)");
  assert.ok(
    Math.abs(result.p - 0.232) < 0.01,
    `expected p within 0.01 of published 0.232, got ${result.p}`
  );
  assert.ok(
    Math.abs(result.medianDiff - 0.95) < 1e-9,
    `expected medianDiff 0.95, got ${result.medianDiff}`
  );
});

// ---------------------------------------------------------------------------
// wilcoxonSignedRank: tie handling (average ranks), hand-verified.
//
// diffs = [1, 1, -2, 3] (n=4, no zeros). Absolute values [1, 1, 2, 3] tie at
// 1, so both get the average of ranks 1 and 2 -> rank 1.5 each; abs=2 gets
// rank 3; abs=3 gets rank 4. W+ (positive diffs: 1, 1, 3) = 1.5+1.5+4 = 7.
// Brute-force enumeration of all 2^4=16 sign assignments over ranks
// {1.5, 1.5, 3, 4} gives P(W+ >= 7) = 5/16 and P(W+ <= 7) = 13/16, so the
// two-sided exact p = 2 * min(5/16, 13/16) = 10/16 = 0.625 exactly.
// ---------------------------------------------------------------------------

test("wilcoxonSignedRank averages tied ranks and computes the exact tied-rank p-value", () => {
  const a = [1, 1, -2, 3];
  const b = [0, 0, 0, 0];

  const result = wilcoxonSignedRank(a, b);

  assert.strictEqual(result.n, 4);
  assert.strictEqual(result.w, 7);
  assert.ok(Math.abs(result.p - 0.625) < 1e-9, `expected exact p 0.625, got ${result.p}`);
  assert.strictEqual(result.medianDiff, 1);
});

test("wilcoxonSignedRank drops zero differences per standard Wilcoxon practice and reports the count", () => {
  const a = [5, 5, 7];
  const b = [5, 3, 2]; // diffs: 0, 2, 5

  const result = wilcoxonSignedRank(a, b);

  assert.strictEqual(result.dropped, 0, "no null entries");
  assert.strictEqual(result.zeros, 1, "one zero-difference pair dropped from the rank test");
  assert.strictEqual(result.n, 2, "signed-rank n excludes the zero-difference pair");
  assert.strictEqual(result.medianDiff, 2, "medianDiff still includes the zero difference (0, 2, 5)");
});

test("wilcoxonSignedRank on all-zero differences is a documented degenerate case (n=0, p=1)", () => {
  const result = wilcoxonSignedRank([5, 5], [5, 5]);

  assert.strictEqual(result.n, 0);
  assert.strictEqual(result.w, 0);
  assert.strictEqual(result.p, 1);
  assert.strictEqual(result.zeros, 2);
});

test("wilcoxonSignedRank drops null-paired entries and reports the dropped count, never substituting values", () => {
  const a = [1, 2, null, 4];
  const b = [0, 1, 5, null];

  const result = wilcoxonSignedRank(a, b);

  assert.strictEqual(result.dropped, 2, "the two pairs with a null entry are dropped");
  assert.strictEqual(result.n, 2, "diffs = [1, 1], both nonzero and tied");
  assert.strictEqual(result.w, 3, "tied ranks 1.5 + 1.5 = 3");
});

test("wilcoxonSignedRank rejects mismatched-length inputs rather than silently truncating", () => {
  assert.throws(() => wilcoxonSignedRank([1, 2], [1]));
});

// ---------------------------------------------------------------------------
// exactBinomial: exact two-sided sign-test p-value.
//
// The classic sign-test worked example: 8 wins, 1 loss (n=9 discordant
// pairs). Under H0 each outcome is Binomial(9, 0.5); the exact two-sided
// p-value doubles the smaller tail:
//   P(X<=1) = (C(9,0)+C(9,1)) / 2^9 = (1+9)/512 = 10/512 = 0.01953125
//   p = 2 * 0.01953125 = 0.0390625
// ---------------------------------------------------------------------------

test("exactBinomial(8, 1) returns the exact two-sided binomial p for 9 discordant pairs", () => {
  const { p } = exactBinomial(8, 1);
  assert.ok(Math.abs(p - 0.0390625) < 1e-9, `expected exact p 0.0390625, got ${p}`);
});

test("exactBinomial is symmetric: wins and losses swapped give the same p", () => {
  assert.strictEqual(exactBinomial(8, 1).p, exactBinomial(1, 8).p);
});

test("exactBinomial caps p at 1 for a perfectly balanced split", () => {
  const { p } = exactBinomial(4, 4);
  assert.strictEqual(p, 1);
});

test("exactBinomial(0, 0) is a documented degenerate case (no discordant pairs, p=1)", () => {
  assert.strictEqual(exactBinomial(0, 0).p, 1);
});

// ---------------------------------------------------------------------------
// summarize: paired summary combining mean/median/wilcoxon, null-safe.
// ---------------------------------------------------------------------------

test("summarize combines meanA, meanB, medianDiff and wilcoxon_p consistently with the standalone functions", () => {
  const a = [10, 12, 14, 9, 11];
  const b = [8, 13, 10, 9, 7];

  const result = summarize(a, b);

  assert.strictEqual(result.n, 5);
  assert.strictEqual(result.dropped, 0);
  assert.strictEqual(result.meanA, mean(a));
  assert.strictEqual(result.meanB, mean(b));

  const w = wilcoxonSignedRank(a, b);
  assert.strictEqual(result.medianDiff, w.medianDiff);
  assert.strictEqual(result.wilcoxon_p, w.p);
});

test("summarize drops null-paired entries pairwise and reports the dropped count", () => {
  const a = [1, 2, null, 4, 5];
  const b = [0, 1, 5, null, 3];

  const result = summarize(a, b);

  assert.strictEqual(result.dropped, 2);
  assert.strictEqual(result.n, 3, "3 pairs survive: (1,0), (2,1), (5,3)");
  assert.strictEqual(result.meanA, mean([1, 2, 5]));
  assert.strictEqual(result.meanB, mean([0, 1, 3]));
});
