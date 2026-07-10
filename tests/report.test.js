"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const {
  SUCCESS_BAR_QUOTE,
  TIER_A_METRICS,
  TIER_B_METRICS,
  minimumNeeded,
  computeScenarioMeans,
  evaluateSuccessBar,
  buildReport,
} = require("../lib/report");
const { DIMENSIONS } = require("../lib/judge");

// =============================================================================
// Fixture builders -- synthetic per-run metric records in the documented
// shape (see bench/lib/report.js doc comment): one record per scenario, each
// carrying `runs_per_cell` runs, each run holding {ideas, brainstorming,
// tierC}. Numbers are hand-chosen, not randomized, so every assertion below
// is exact and reproducible.
// =============================================================================

const CONFIG = {
  interviewee_model: "claude-sonnet-5",
  simuser_model: "claude-sonnet-5",
  judge_model: "claude-opus-4-8",
  runs_per_cell: 3,
  turn_cap: 25,
};

// ideas: fewer tokens, more questions, more turns-per-question but FEWER
// total turns is NOT what we want here -- we deliberately give brainstorming
// fewer turns (a real, honest "brainstorming wins" case, matching the actual
// transcript-pair fixture from Task 4: brainstorming's shallow single-shot
// draft racks up fewer turns than ideas' batched interview) while ideas
// wins on tokens, burden, elicitation, and spec quality.
function tierA({ output_tokens, questions_asked, turns, user_burden_tokens }) {
  return { output_tokens, output_tokens_complete: true, questions_asked, turns, user_burden_tokens };
}

function tierB({ active_pct, critical_coverage, silent, flagged }) {
  return {
    facts: [],
    active_pct,
    critical_coverage,
    silent_assumptions: new Array(silent).fill("an unflagged assumption"),
    flagged_assumptions: new Array(flagged).fill("a flagged assumption"),
    error: null,
  };
}

function dimScore(a, b) {
  return { A: a, B: b, raw: [], error: null };
}

function tierCRun(ideasScore, brainstormingScore) {
  const dims = {};
  for (const dim of DIMENSIONS) dims[dim] = dimScore(ideasScore, brainstormingScore);
  return dims;
}

// One scenario, 3 runs, where ideas wins on tokens/burden/elicitation/quality
// and brainstorming wins on turn count.
function winningScenario(id, n) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push({
      ideas: {
        tierA: tierA({ output_tokens: 300 + n, questions_asked: 6, turns: 6, user_burden_tokens: 60 + n }),
        tierB: tierB({ active_pct: 0.8, critical_coverage: 1, silent: 0, flagged: 1 }),
      },
      brainstorming: {
        tierA: tierA({ output_tokens: 600 + n, questions_asked: 1, turns: 4, user_burden_tokens: 90 + n }),
        tierB: tierB({ active_pct: 0.3, critical_coverage: 0.5, silent: 2, flagged: 0 }),
      },
      tierC: tierCRun(4.5, 2.5),
    });
  }
  return {
    id,
    title: `Scenario ${id}`,
    meta: { facts: new Array(8).fill(0).map((_, i) => ({ id: `f${i}` })), ambiguities: ["a1", "a2", "a3"] },
    runs,
  };
}

function sixWinningScenarios() {
  return ["s01", "s02", "s03", "s04", "s05", "s06"].map((id, i) => winningScenario(id, i));
}

// =============================================================================
// minimumNeeded: the documented heuristic proxy for "minimum questions needed"
// =============================================================================

test("minimumNeeded sums planted facts and seeded ambiguities from scenario meta", () => {
  const meta = { facts: [{ id: "f1" }, { id: "f2" }], ambiguities: ["a1", "a2", "a3"] };
  assert.strictEqual(minimumNeeded(meta), 5);
});

test("minimumNeeded returns null (never fabricates) when meta is missing facts or ambiguities", () => {
  assert.strictEqual(minimumNeeded(null), null);
  assert.strictEqual(minimumNeeded({ facts: [] }), null);
  assert.strictEqual(minimumNeeded({ ambiguities: [] }), null);
});

// =============================================================================
// computeScenarioMeans: per-scenario, per-side averages across runs_per_cell
// =============================================================================

test("computeScenarioMeans averages tierA/tierB across runs and computes the tierC composite", () => {
  const scenario = winningScenario("s01", 0);
  const means = computeScenarioMeans(scenario);

  assert.strictEqual(means.ideas.output_tokens, 300);
  assert.strictEqual(means.brainstorming.output_tokens, 600);
  assert.strictEqual(means.ideas.turns, 6);
  assert.strictEqual(means.brainstorming.turns, 4, "brainstorming genuinely wins on turn count in this fixture");
  assert.ok(Math.abs(means.ideas.active_pct - 0.8) < 1e-9);
  assert.strictEqual(means.ideas.silent_assumptions_count, 0);
  assert.strictEqual(means.brainstorming.silent_assumptions_count, 2);

  for (const dim of DIMENSIONS) {
    assert.strictEqual(means.tierCDimensions[dim].A, 4.5);
    assert.strictEqual(means.tierCDimensions[dim].B, 2.5);
  }
  assert.strictEqual(means.tierCComposite.A, 4.5);
  assert.strictEqual(means.tierCComposite.B, 2.5);
});

test("computeScenarioMeans drops null tierA/tierB entries and never fabricates a mean from zero usable runs", () => {
  const scenario = {
    id: "sX",
    title: "sX",
    meta: { facts: [{ id: "f1" }], ambiguities: ["a1"] },
    runs: [
      { ideas: { tierA: null, tierB: null }, brainstorming: { tierA: null, tierB: null }, tierC: null },
      { ideas: { tierA: null, tierB: null }, brainstorming: { tierA: null, tierB: null }, tierC: null },
    ],
  };
  const means = computeScenarioMeans(scenario);
  assert.strictEqual(means.ideas.output_tokens, null);
  assert.strictEqual(means.brainstorming.output_tokens, null);
  assert.strictEqual(means.tierCComposite.A, null);
  assert.strictEqual(means.tierCComposite.B, null);
});

test("computeScenarioMeans query_discrepancy uses tierA.questions_asked minus the minimumNeeded heuristic", () => {
  const scenario = winningScenario("s01", 0);
  const means = computeScenarioMeans(scenario);
  // minimumNeeded = 8 facts + 3 ambiguities = 11; ideas asked 6 -> -5; brainstorming asked 1 -> -10.
  assert.strictEqual(means.ideas.query_discrepancy, 6 - 11);
  assert.strictEqual(means.brainstorming.query_discrepancy, 1 - 11);
});

// =============================================================================
// evaluateSuccessBar: PASS / FAIL / INSUFFICIENT-DATA, exactly per the
// brief's EARS criterion: >=30% fewer output tokens AND match-or-beat tier C
// composite AND match-or-beat tier D when present.
// =============================================================================

function summaryOf(a, b) {
  const { summarize } = require("../lib/stats");
  return summarize(a, b);
}

test("evaluateSuccessBar PASSes when tokens drop >=30%, tier C matches-or-beats, burden is lower, and no tier D is present", () => {
  const tokenSummary = summaryOf([300, 300, 300], [600, 600, 600]); // 50% fewer
  const tierCSummary = summaryOf([4.5, 4.5, 4.5], [2.5, 2.5, 2.5]); // ideas beats
  const userBurdenSummary = summaryOf([60, 60, 60], [90, 90, 90]); // ideas' burden strictly lower

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "PASS");
  assert.ok(result.tokenReductionPct >= 0.3);
  assert.strictEqual(result.userBurdenPass, true);
  assert.strictEqual(result.tierDPass, null, "tier D was not supplied -- not run, not blocking");
});

// Spec section 13's bar has FOUR conditions -- tier D pass rate, tier C
// composite, >=30% fewer output tokens, AND "imposing lower user burden".
// User burden gates the verdict like the other three.

test("evaluateSuccessBar FAILs when ideas' user burden is higher, even with tokens and tier C passing", () => {
  const tokenSummary = summaryOf([300, 300, 300], [600, 600, 600]);
  const tierCSummary = summaryOf([4.5, 4.5, 4.5], [2.5, 2.5, 2.5]);
  const userBurdenSummary = summaryOf([120, 120, 120], [90, 90, 90]); // ideas' burden HIGHER

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "FAIL");
  assert.strictEqual(result.userBurdenPass, false);
});

test("evaluateSuccessBar does not PASS on exactly equal user burden -- the spec says lower, not lower-or-equal", () => {
  const tokenSummary = summaryOf([300, 300, 300], [600, 600, 600]);
  const tierCSummary = summaryOf([4.5, 4.5, 4.5], [2.5, 2.5, 2.5]);
  const userBurdenSummary = summaryOf([90, 90, 90], [90, 90, 90]); // exactly equal

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.notStrictEqual(result.verdict, "PASS");
  assert.strictEqual(result.verdict, "FAIL");
  assert.strictEqual(result.userBurdenPass, false);
});

test("evaluateSuccessBar reports INSUFFICIENT-DATA when the user-burden metric family is entirely null", () => {
  const tokenSummary = summaryOf([300, 300], [600, 600]);
  const tierCSummary = summaryOf([4.5, 4.5], [2.5, 2.5]);
  const userBurdenSummary = summaryOf([null, null], [null, null]); // n=0

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "INSUFFICIENT-DATA");
});

test("evaluateSuccessBar FAILs when the token reduction is under 30% even if tier C wins", () => {
  const tokenSummary = summaryOf([550, 550, 550], [600, 600, 600]); // ~8% fewer, under the bar
  const tierCSummary = summaryOf([4.5, 4.5, 4.5], [2.5, 2.5, 2.5]);
  const userBurdenSummary = summaryOf([60], [90]);

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "FAIL");
  assert.strictEqual(result.tokensPass, false);
});

test("evaluateSuccessBar FAILs when tier D is present and ideas loses it, even with tokens+tierC passing", () => {
  const tokenSummary = summaryOf([300, 300], [600, 600]);
  const tierCSummary = summaryOf([4.5, 4.5], [2.5, 2.5]);
  const userBurdenSummary = summaryOf([60], [90]);
  const tierDSummary = summaryOf([0, 0, 1], [1, 1, 1]); // ideas pass rate 0.33 < brainstorming 1.0

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary });
  assert.strictEqual(result.verdict, "FAIL");
  assert.strictEqual(result.tierDPass, false);
});

test("evaluateSuccessBar reports INSUFFICIENT-DATA (never PASS or FAIL) when the token metric family is entirely null", () => {
  const tokenSummary = summaryOf([null, null], [null, null]); // n=0
  const tierCSummary = summaryOf([4.5, 4.5], [2.5, 2.5]);
  const userBurdenSummary = summaryOf([60], [90]);

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "INSUFFICIENT-DATA");
  assert.notStrictEqual(result.verdict, "PASS");
  assert.notStrictEqual(result.verdict, "FAIL");
});

test("evaluateSuccessBar reports INSUFFICIENT-DATA when the tier C composite family is entirely null", () => {
  const tokenSummary = summaryOf([300, 300], [600, 600]);
  const tierCSummary = summaryOf([null, null], [null, null]);
  const userBurdenSummary = summaryOf([60], [90]);

  const result = evaluateSuccessBar({ tokenSummary, tierCCompositeSummary: tierCSummary, userBurdenSummary, tierDSummary: null });
  assert.strictEqual(result.verdict, "INSUFFICIENT-DATA");
});

// =============================================================================
// buildReport: full markdown rendering
// =============================================================================

test("SUCCESS_BAR_QUOTE matches spec section 13's pre-declared success bar paragraph verbatim", () => {
  assert.strictEqual(
    SUCCESS_BAR_QUOTE,
    "ideas must match or beat brainstorming on tier D pass rate and the tier C composite, while spending " +
      "at least 30% fewer output tokens per spec and imposing lower user burden. If it misses, the spec's " +
      "claims are revised — never the numbers. (The plan-runner honesty invariants apply to our own " +
      "benchmark first.)"
  );
});

test("buildReport renders every pre-declared tier A/B/C metric, including the one where brainstorming wins", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });

  for (const m of TIER_A_METRICS) assert.ok(md.includes(m.label), `tier A table includes "${m.label}"`);
  for (const m of TIER_B_METRICS) assert.ok(md.includes(m.label), `tier B table includes "${m.label}"`);
  for (const dim of DIMENSIONS) assert.ok(md.includes(dim), `tier C table includes dimension "${dim}"`);
  assert.match(md, /[Cc]omposite/, "tier C composite is rendered");

  // Turn count is the metric where brainstorming wins in this fixture (4 < 6)
  // -- the report must still surface it, not omit an unfavorable result.
  const turnsLine = md.split("\n").find((l) => l.includes(TIER_A_METRICS.find((m) => m.key === "turns").label));
  assert.ok(turnsLine, "turns row is present");
  assert.ok(turnsLine.includes("6.00") && turnsLine.includes("4.00"), "turns row shows brainstorming's lower (winning) value");
});

test("buildReport includes Wilcoxon p-values and null/dropped coverage counters for every metric row", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  // Every metric row is a markdown table row with n and dropped columns; spot-check the header names them.
  assert.match(md, /Wilcoxon/i);
  assert.match(md, /\bn\b/);
  assert.match(md, /dropped/i);
});

test("buildReport PASSes the success bar for the six winning scenarios and quotes the bar verbatim", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.ok(md.includes(SUCCESS_BAR_QUOTE), "the success bar text is quoted verbatim");
  // No tier D results were supplied -- the headline itself must carry the
  // qualifier, not just the reasons list below it.
  assert.match(md, /Success bar[\s\S]{0,600}\*\*Verdict: PASS \(tier D not evaluated\)\*\*/);
});

test("buildReport's verdict headline carries '(tier D not evaluated)' on both PASS and FAIL when tier D was not supplied", () => {
  const passMd = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.match(passMd, /\*\*Verdict: PASS \(tier D not evaluated\)\*\*/);

  const losingScenarios = sixWinningScenarios().map((s) => ({
    ...s,
    runs: s.runs.map((r) => ({
      ...r,
      ideas: { ...r.ideas, tierA: { ...r.ideas.tierA, output_tokens: r.brainstorming.tierA.output_tokens } },
    })),
  }));
  const failMd = buildReport({ scenarios: losingScenarios, tierD: null, config: CONFIG, versions: {} });
  assert.match(failMd, /\*\*Verdict: FAIL \(tier D not evaluated\)\*\*/);
});

test("buildReport's verdict headline carries no qualifier when tier D results are supplied", () => {
  const tierD = [
    { scenarioId: "s01", ideas_pass: true, brainstorming_pass: false },
    { scenarioId: "s02", ideas_pass: true, brainstorming_pass: true },
  ];
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD, config: CONFIG, versions: {} });
  assert.match(md, /\*\*Verdict: PASS\*\*/);
  assert.doesNotMatch(md, /tier D not evaluated/);
});

test("buildReport labels a run with fewer than 15 scenarios PILOT (no silent caps)", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.match(md, /PILOT/);
  assert.match(md, /\b6\b/); // scenario count surfaced somewhere
});

test("buildReport does NOT label a run with >=15 scenarios PILOT", () => {
  const scenarios = [];
  for (let i = 0; i < 15; i++) scenarios.push(winningScenario(`s${i}`, i));
  const md = buildReport({ scenarios, tierD: null, config: CONFIG, versions: {} });
  assert.doesNotMatch(md, /\bPILOT\b/);
});

test("buildReport renders tier D as not-run when no tier D results are supplied", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.match(md, /not run/i);
  assert.match(md, /manual procedure/i);
});

test("buildReport renders tier D pass-rate table with exact-binomial p when results are supplied", () => {
  const tierD = [
    { scenarioId: "s01", ideas_pass: true, brainstorming_pass: false },
    { scenarioId: "s02", ideas_pass: true, brainstorming_pass: true },
    { scenarioId: "s03", ideas_pass: true, brainstorming_pass: false },
  ];
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD, config: CONFIG, versions: {} });
  assert.match(md, /Tier D/);
  assert.doesNotMatch(md.split(/## Tier D/)[1].split(/\n## /)[0], /not run/i);
  assert.match(md, /binomial/i);
});

test("buildReport's mandatory Caveats section covers pilot N, prose-mode, same-family judge, and sim-user relativity", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.match(md, /## Caveats/);
  const caveats = md.split("## Caveats")[1];
  assert.match(caveats, /PILOT/i);
  assert.match(caveats, /numbered prose/i, "headless AskUserQuestion / prose-mode variant caveat");
  assert.match(caveats, /same[- ]family|Claude model/i, "same-family judge caveat");
  assert.match(caveats, /relative|Lost in Simulation/i, "sim-user relativity caveat");
  assert.match(caveats, /best-effort/i, "token accounting / version-pin honesty caveat");
});

test("buildReport's Caveats section records pinned versions best-effort, with null rendered honestly (not fabricated)", () => {
  const md = buildReport({
    scenarios: sixWinningScenarios(),
    tierD: null,
    config: CONFIG,
    versions: { ideas: "0.2.0", superpowers: null, claude_cli: null },
  });
  assert.ok(md.includes("0.2.0"));
  assert.match(md, /superpowers[\s\S]{0,40}(null|unavailable|unknown)/i);
});

// =============================================================================
// MUST FIX 1: output_tokens_complete propagates to the report as a per-side
// usage-coverage counter; the output_tokens row is labeled a lower bound
// when coverage is under 100%, and the success bar's token condition still
// computes normally (labeled, not blocked).
// =============================================================================

test("buildReport does not label output_tokens a lower bound when every run reports complete usage", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  const tokenLabel = TIER_A_METRICS.find((m) => m.key === "output_tokens").label;
  const tokenLine = md.split("\n").find((l) => l.includes(tokenLabel));
  assert.ok(tokenLine, "output_tokens row is present");
  assert.doesNotMatch(tokenLine, /lower bound \(usage incomplete\)/, "the row itself carries no lower-bound label at 100% coverage");
  assert.match(md, /ideas: 18\/18 scored run\(s\) \(100\.0%\) reported complete usage/);
  assert.match(md, /brainstorming: 18\/18 scored run\(s\) \(100\.0%\) reported complete usage/);
});

test("buildReport labels output_tokens a lower bound and surfaces the usage-coverage counter when a run has partial usage", () => {
  const scenarios = sixWinningScenarios();
  // One of ideas' 18 runs (6 scenarios x 3 runs) reports incomplete usage.
  scenarios[0].runs[0] = {
    ...scenarios[0].runs[0],
    ideas: {
      ...scenarios[0].runs[0].ideas,
      tierA: { ...scenarios[0].runs[0].ideas.tierA, output_tokens_complete: false },
    },
  };

  const md = buildReport({ scenarios, tierD: null, config: CONFIG, versions: {} });

  const tokenLabel = TIER_A_METRICS.find((m) => m.key === "output_tokens").label;
  const tokenLine = md.split("\n").find((l) => l.includes(tokenLabel));
  assert.ok(tokenLine, "output_tokens row is present");
  assert.match(tokenLine, /lower bound \(usage incomplete\)/, "the row itself carries the lower-bound label");

  assert.match(md, /ideas: 17\/18 scored run\(s\) \(94\.4%\) reported complete usage/);
  assert.match(md, /brainstorming: 18\/18 scored run\(s\) \(100\.0%\) reported complete usage/);

  // The success bar's token condition still computes (labeled, not blocked)
  // -- partial usage coverage does not force INSUFFICIENT-DATA or drop the
  // token condition out of the verdict.
  assert.doesNotMatch(md, /INSUFFICIENT-DATA/);
  assert.match(md, /Token reduction: [\d.]+% \(bar: >=30%\) -- (PASS|FAIL)/);
});

// =============================================================================
// MUST FIX 2: judge temperature cannot be pinned via the CLI -- the caveat
// must reach the generated report, not just judge.js's code comment.
// =============================================================================

test("buildReport's Caveats section discloses that judge temperature cannot be pinned via the CLI", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  const caveats = md.split("## Caveats")[1];
  assert.match(caveats, /temperature/i);
  assert.match(caveats, /cannot be pinned/i);
  assert.match(caveats, /no temperature/i);
});

// =============================================================================
// MINOR 6: tier C composite row is labeled "mean of available dimensions",
// not "all 5" -- a dimension that failed its judge call is excluded, not
// silently averaged in as if every dimension always succeeds.
// =============================================================================

test("buildReport's tier C composite row is labeled 'mean of available dimensions', not 'all 5'", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.match(md, /Composite \(mean of available dimensions\)/);
  assert.doesNotMatch(md, /mean of all 5 dimensions/);
});

test("buildReport never claims completeness beyond what coverage counters support (dropped scenarios are visible)", () => {
  const scenarios = sixWinningScenarios();
  // Zero out one scenario's tierA/tierB entirely so it's dropped from token/tierB pairing.
  scenarios[0].runs = scenarios[0].runs.map((r) => ({
    ideas: { tierA: null, tierB: null },
    brainstorming: { tierA: null, tierB: null },
    tierC: r.tierC,
  }));

  const md = buildReport({ scenarios, tierD: null, config: CONFIG, versions: {} });
  // The output-tokens row must show n=5 (not 6) and dropped=1.
  const tokenLabel = TIER_A_METRICS.find((m) => m.key === "output_tokens").label;
  const tokenLine = md.split("\n").find((l) => l.includes(tokenLabel));
  assert.ok(tokenLine.includes("| 5 |"), "n reflects only the 5 scenarios with usable paired data");
  assert.ok(tokenLine.includes("| 1 |") || /\| 1 \|$/.test(tokenLine.trim()), "dropped count reflects the 1 null scenario");
});

test("buildReport surfaces config model pins (interviewee/simuser/judge) so the report names what ran", () => {
  const md = buildReport({ scenarios: sixWinningScenarios(), tierD: null, config: CONFIG, versions: {} });
  assert.ok(md.includes(CONFIG.interviewee_model));
  assert.ok(md.includes(CONFIG.simuser_model));
  assert.ok(md.includes(CONFIG.judge_model));
});
