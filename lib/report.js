"use strict";

// Aggregates per-run tier A/B/C metric records into paired per-scenario
// means, runs the paired statistics from stats.js across scenarios, and
// renders the whole thing as bench/runs/report.md. Pure -- no fs, no exec
// calls -- so it is fully unit-testable against hand-built fixture records
// (see bench/tests/report.test.js). bench/run.js owns reading the per-run
// metrics JSONs off disk and writing this module's markdown output back to
// disk.
//
// Input shape (buildReport's `scenarios` argument): one entry per scenario,
// each carrying `config.runs_per_cell` runs:
//
//   {
//     id, title, meta: {facts: [...], ambiguities: [...]},
//     runs: [
//       {
//         ideas:         { tierA: <metrics.tierA() shape | null>, tierB: <metrics.tierB() shape | null> },
//         brainstorming: { tierA: <...> | null,                    tierB: <...> | null },
//         tierC: <metrics.tierC() shape | null>,   // PAIRED -- one masked judge comparison per scenario+run, not per side
//       },
//       ...
//     ],
//   }
//
// `tierD` (optional): [{ scenarioId, ideas_pass: bool|null, brainstorming_pass: bool|null }, ...] | null.
// Tier D is not automated (see bench/README.md's manual procedure) -- null
// means "not run" and is rendered as such, never silently treated as 0 wins.

const { summarize, exactBinomial } = require("./stats");
const { DIMENSIONS } = require("./judge");

// The success bar text is quoted verbatim from docs/specs/2026-07-08-ideas-design.md
// section 13, "Pre-declared success bar" paragraph. Never paraphrase this --
// the plan header's flagged constraints and the Caveats section both depend
// on the report naming exactly what was pre-declared, not a rephrasing of it.
const SUCCESS_BAR_QUOTE =
  "ideas must match or beat brainstorming on tier D pass rate and the tier C composite, while spending " +
  "at least 30% fewer output tokens per spec and imposing lower user burden. If it misses, the spec's " +
  "claims are revised — never the numbers. (The plan-runner honesty invariants apply to our own " +
  "benchmark first.)";

const PILOT_N_THRESHOLD = 15; // spec section 13: N = 15-20 scenarios
const TOKEN_REDUCTION_BAR = 0.3; // spec section 13 / plan Task 5 EARS: >=30% fewer output tokens

// --- pre-declared metric catalogs -------------------------------------------
//
// Every metric spec section 13 pre-declares for tier A/B that this harness
// actually has data for (see the Task 4 review carry-forward note: tier B's
// "information gain per question" is NOT computed by metrics.js and is
// therefore not fabricated here). Order is render order.

const TIER_A_METRICS = [
  { key: "output_tokens", label: "Output tokens per spec (primary cost metric)" },
  { key: "questions_asked", label: "Questions asked (tier A post-hoc count -- see bench/README.md)" },
  { key: "turns", label: "Turn count" },
  { key: "user_burden_tokens", label: "Simulated-user burden tokens (approximate)" },
  { key: "query_discrepancy", label: "Query discrepancy (questions asked minus minimum needed)" },
];

const TIER_B_METRICS = [
  { key: "active_pct", label: "Active Elicited % (headline interview-skill metric)" },
  { key: "critical_coverage", label: "Critical-fact coverage (weighted)" },
  { key: "silent_assumptions_count", label: "Silent assumptions per spec (avg count -- lower is more honest)" },
  { key: "flagged_assumptions_count", label: "Flagged assumptions per spec (avg count)" },
];

// --- null-safe local helpers ------------------------------------------------

function meanAcrossRuns(values) {
  const usable = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((sum, v) => sum + v, 0) / usable.length;
}

// minimumNeeded(meta) -> number | null
//
// Spec section 13 lists "query discrepancy (questions asked vs. minimum
// needed)" as a tier A metric but never defines "minimum needed" precisely.
// This harness uses a documented heuristic proxy, not ground truth: the
// count of planted facts plus seeded ambiguities in the scenario's
// meta.json -- the smallest set of things a perfect interviewer would need
// to ask about to resolve every fact and ambiguity. Returns null (never 0)
// when meta is missing either array, so a missing scenario meta can never
// silently produce a fabricated discrepancy of "questions_asked - 0".
function minimumNeeded(meta) {
  const facts = meta && Array.isArray(meta.facts) ? meta.facts.length : null;
  const ambiguities = meta && Array.isArray(meta.ambiguities) ? meta.ambiguities.length : null;
  if (facts === null || ambiguities === null) return null;
  return facts + ambiguities;
}

function tierAValue(tierA, key, minNeeded) {
  if (!tierA) return null;
  if (key === "query_discrepancy") {
    return typeof tierA.questions_asked === "number" && typeof minNeeded === "number"
      ? tierA.questions_asked - minNeeded
      : null;
  }
  const v = tierA[key];
  return typeof v === "number" ? v : null;
}

function tierBValue(tierB, key) {
  if (!tierB) return null;
  if (key === "silent_assumptions_count") {
    return Array.isArray(tierB.silent_assumptions) ? tierB.silent_assumptions.length : null;
  }
  if (key === "flagged_assumptions_count") {
    return Array.isArray(tierB.flagged_assumptions) ? tierB.flagged_assumptions.length : null;
  }
  const v = tierB[key];
  return typeof v === "number" ? v : null;
}

// tierCCompositeForRun(dimensions) -> {A, B} | {A: null, B: null}
//
// One run's tier C composite is the mean of whichever of the 5 dimensions
// produced a usable (non-null) score for that side -- a dimension that
// failed its judge call (see metrics.js's judgeDimension) contributes
// nothing rather than a fabricated 0.
function tierCCompositeForRun(dimensions) {
  if (!dimensions) return { A: null, B: null };
  const as = [];
  const bs = [];
  for (const dim of DIMENSIONS) {
    const d = dimensions[dim];
    if (d && typeof d.A === "number") as.push(d.A);
    if (d && typeof d.B === "number") bs.push(d.B);
  }
  return { A: as.length ? meanAcrossRuns(as) : null, B: bs.length ? meanAcrossRuns(bs) : null };
}

// computeScenarioMeans(scenario) -> per-scenario, per-side means over runs_per_cell runs
function computeScenarioMeans(scenario) {
  const runs = Array.isArray(scenario.runs) ? scenario.runs : [];
  const minNeeded = minimumNeeded(scenario.meta);

  const ideas = {};
  const brainstorming = {};
  for (const m of TIER_A_METRICS) {
    ideas[m.key] = meanAcrossRuns(runs.map((r) => tierAValue(r.ideas && r.ideas.tierA, m.key, minNeeded)));
    brainstorming[m.key] = meanAcrossRuns(
      runs.map((r) => tierAValue(r.brainstorming && r.brainstorming.tierA, m.key, minNeeded))
    );
  }
  for (const m of TIER_B_METRICS) {
    ideas[m.key] = meanAcrossRuns(runs.map((r) => tierBValue(r.ideas && r.ideas.tierB, m.key)));
    brainstorming[m.key] = meanAcrossRuns(runs.map((r) => tierBValue(r.brainstorming && r.brainstorming.tierB, m.key)));
  }

  const tierCDimensions = {};
  for (const dim of DIMENSIONS) {
    const as = runs.map((r) => (r.tierC && r.tierC[dim] && typeof r.tierC[dim].A === "number" ? r.tierC[dim].A : null));
    const bs = runs.map((r) => (r.tierC && r.tierC[dim] && typeof r.tierC[dim].B === "number" ? r.tierC[dim].B : null));
    tierCDimensions[dim] = { A: meanAcrossRuns(as), B: meanAcrossRuns(bs) };
  }
  const tierCComposite = {
    A: meanAcrossRuns(runs.map((r) => tierCCompositeForRun(r.tierC).A)),
    B: meanAcrossRuns(runs.map((r) => tierCCompositeForRun(r.tierC).B)),
  };

  return {
    id: scenario.id,
    title: scenario.title || scenario.id,
    ideas,
    brainstorming,
    tierCDimensions,
    tierCComposite,
  };
}

// pctFewer(meanIdeas, meanBrainstorming) -> fraction (0.3 = 30% fewer) | null
function pctFewer(meanIdeas, meanBrainstorming) {
  if (typeof meanIdeas !== "number" || typeof meanBrainstorming !== "number" || meanBrainstorming === 0) return null;
  return (meanBrainstorming - meanIdeas) / meanBrainstorming;
}

// evaluateSuccessBar({tokenSummary, tierCCompositeSummary, userBurdenSummary, tierDSummary}) -> verdict
//
// Bar (plan Task 5 EARS criterion, matching spec section 13): >=30% fewer
// output tokens AND match-or-beat tier C composite AND match-or-beat tier D
// pass rate when tier D results are present. User burden is reported
// alongside (the full spec paragraph also names it) but does not itself
// gate PASS/FAIL, so a burden-data gap can never turn an otherwise-decided
// bar into a spurious FAIL.
//
// WHEN the token-cost family or the tier C composite family is entirely
// null, the verdict is INSUFFICIENT-DATA -- never PASS or FAIL. If tier D
// results were supplied but are entirely null, that also forces
// INSUFFICIENT-DATA (data was attempted, not simply not-run).
function evaluateSuccessBar({ tokenSummary, tierCCompositeSummary, userBurdenSummary, tierDSummary }) {
  const tokenFamilyNull = tokenSummary.n === 0;
  const tierCFamilyNull = tierCCompositeSummary.n === 0;
  if (tokenFamilyNull || tierCFamilyNull) {
    return {
      verdict: "INSUFFICIENT-DATA",
      reasons: [
        tokenFamilyNull ? "output-tokens metric family is entirely null (no scenario had usable paired data)" : null,
        tierCFamilyNull ? "tier C composite metric family is entirely null (no scenario had usable paired data)" : null,
      ].filter(Boolean),
    };
  }

  const tokenReductionPct = pctFewer(tokenSummary.meanA, tokenSummary.meanB);
  const tokensPass = typeof tokenReductionPct === "number" && tokenReductionPct >= TOKEN_REDUCTION_BAR;
  const tierCPass =
    tierCCompositeSummary.meanA !== null &&
    tierCCompositeSummary.meanB !== null &&
    tierCCompositeSummary.meanA >= tierCCompositeSummary.meanB;

  const userBurdenPass =
    userBurdenSummary.n > 0 && userBurdenSummary.meanA !== null && userBurdenSummary.meanB !== null
      ? userBurdenSummary.meanA <= userBurdenSummary.meanB
      : null;

  let tierDPass = null;
  if (tierDSummary) {
    if (tierDSummary.n === 0) {
      return {
        verdict: "INSUFFICIENT-DATA",
        reasons: ["tier D results were supplied but contained no usable paired data"],
      };
    }
    tierDPass = tierDSummary.meanA !== null && tierDSummary.meanB !== null && tierDSummary.meanA >= tierDSummary.meanB;
  }

  const pass = tokensPass && tierCPass && tierDPass !== false;
  return {
    verdict: pass ? "PASS" : "FAIL",
    tokensPass,
    tierCPass,
    userBurdenPass,
    tierDPass,
    tokenReductionPct,
  };
}

// --- markdown rendering ------------------------------------------------------

function fmtNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}
function fmtP(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "—";
}
function fmtPct(v) {
  return typeof v === "number" && Number.isFinite(v) ? (v * 100).toFixed(1) + "%" : "—";
}

function pairedTableHeader() {
  return [
    "| Metric | ideas mean | brainstorming mean | median diff (ideas - brainstorming) | Wilcoxon p | n (scenarios) | dropped |",
    "|---|---|---|---|---|---|---|",
  ];
}

function metricRow(label, summary) {
  return `| ${label} | ${fmtNum(summary.meanA)} | ${fmtNum(summary.meanB)} | ${fmtNum(summary.medianDiff)} | ${fmtP(
    summary.wilcoxon_p
  )} | ${summary.n} | ${summary.dropped} |`;
}

// buildMetricTable(perScenario, metricDefs, sideKey) -> {rows, summaries}
//
// sideKey selects which per-scenario field holds each side's means
// ("ideas"/"brainstorming" for tier A/B, "tierCDimensions"/"tierCComposite"
// handled separately below since they're keyed by dimension, not a flat
// metric list).
function buildMetricTable(perScenario, metricDefs) {
  const lines = [...pairedTableHeader()];
  const summaries = {};
  for (const m of metricDefs) {
    const a = perScenario.map((s) => s.ideas[m.key]);
    const b = perScenario.map((s) => s.brainstorming[m.key]);
    const summary = summarize(a, b);
    summaries[m.key] = summary;
    lines.push(metricRow(m.label, summary));
  }
  return { lines, summaries };
}

function buildTierCTable(perScenario) {
  const lines = [...pairedTableHeader()];
  const dimensionSummaries = {};
  for (const dim of DIMENSIONS) {
    const a = perScenario.map((s) => s.tierCDimensions[dim].A);
    const b = perScenario.map((s) => s.tierCDimensions[dim].B);
    const summary = summarize(a, b);
    dimensionSummaries[dim] = summary;
    lines.push(metricRow(dim, summary));
  }
  const compositeA = perScenario.map((s) => s.tierCComposite.A);
  const compositeB = perScenario.map((s) => s.tierCComposite.B);
  const compositeSummary = summarize(compositeA, compositeB);
  lines.push(metricRow("**Composite (mean of all 5 dimensions)**", compositeSummary));
  return { lines, dimensionSummaries, compositeSummary };
}

function buildTierDSection(tierD) {
  if (!tierD || tierD.length === 0) {
    return {
      lines: [
        "## Tier D — downstream outcome (subset of 6-8 scenarios)",
        "",
        "**not run.** Tier D is not automated in this version -- it is a documented manual procedure " +
          "(see bench/README.md): the same fixed executor implements from each spec with no access to the " +
          "hidden doc, and the held-out acceptance suite decides pass/fail. Supply a tier-d results file to " +
          "render this section.",
        "",
      ],
      summary: null,
    };
  }

  const boolToNum = (v) => (v === true ? 1 : v === false ? 0 : null);
  const ideasVals = tierD.map((r) => boolToNum(r.ideas_pass));
  const brainstormVals = tierD.map((r) => boolToNum(r.brainstorming_pass));
  const summary = summarize(ideasVals, brainstormVals);

  let wins = 0;
  let losses = 0;
  for (const r of tierD) {
    if (typeof r.ideas_pass !== "boolean" || typeof r.brainstorming_pass !== "boolean") continue;
    if (r.ideas_pass === r.brainstorming_pass) continue;
    if (r.ideas_pass) wins += 1;
    else losses += 1;
  }
  const binomial = exactBinomial(wins, losses);

  const lines = [
    "## Tier D — downstream outcome (subset of 6-8 scenarios)",
    "",
    "Pass rate is the primary metric of the whole benchmark (spec section 13). Results below come from a " +
      "supplied tier-d results file -- Tier D itself remains a manual procedure, not automated by this CLI.",
    "",
    "| Metric | ideas pass rate | brainstorming pass rate | median diff | Wilcoxon p | n (scenarios) | dropped |",
    "|---|---|---|---|---|---|---|",
    metricRow("Tier D pass rate", summary),
    "",
    `Exact binomial (sign test) on ${wins + losses} discordant scenario(s): ideas wins ${wins}, loses ${losses}, ` +
      `p = ${fmtP(binomial.p)}.`,
    "",
  ];
  return { lines, summary };
}

function bestEffort(v) {
  return v === null || v === undefined || v === "" ? "null (unavailable)" : v;
}

// buildReport({scenarios, tierD, config, versions}) -> markdown string
function buildReport({ scenarios, tierD, config, versions }) {
  const perScenario = (Array.isArray(scenarios) ? scenarios : []).map(computeScenarioMeans);
  const scenarioCount = perScenario.length;
  const pilot = scenarioCount < PILOT_N_THRESHOLD;

  const tierA = buildMetricTable(perScenario, TIER_A_METRICS);
  const tierB = buildMetricTable(perScenario, TIER_B_METRICS);
  const tierC = buildTierCTable(perScenario);
  const tierDSection = buildTierDSection(tierD);

  const tokenSummary = tierA.summaries.output_tokens;
  const userBurdenSummary = tierA.summaries.user_burden_tokens;
  const tierCCompositeSummary = tierC.compositeSummary;
  const tierDSummary = tierDSection.summary;

  const bar = evaluateSuccessBar({
    tokenSummary,
    tierCCompositeSummary,
    userBurdenSummary,
    tierDSummary,
  });

  const v = versions || {};
  const cfg = config || {};

  const lines = [];
  lines.push(`# bench run report${pilot ? " (PILOT)" : ""}`);
  lines.push("");
  lines.push(
    `${scenarioCount} scenario(s) scored${pilot ? ` -- **PILOT**: below spec section 13's target N of 15-20` : ""}. ` +
      `${cfg.runs_per_cell || "?"} run(s) per scenario per workflow.`
  );
  lines.push("");
  lines.push("## Pinned configuration");
  lines.push("");
  lines.push(`- Interviewee model: ${bestEffort(cfg.interviewee_model)}`);
  lines.push(`- Simulated-user model: ${bestEffort(cfg.simuser_model)}`);
  lines.push(`- Judge model: ${bestEffort(cfg.judge_model)}`);
  lines.push(`- Turn cap: ${bestEffort(cfg.turn_cap)}`);
  lines.push(`- ideas plugin version: ${bestEffort(v.ideas)}`);
  lines.push(`- superpowers plugin version: ${bestEffort(v.superpowers)}`);
  lines.push(`- claude CLI version: ${bestEffort(v.claude_cli)}`);
  lines.push("");

  lines.push("## Tier A — cost/burden (deterministic from transcripts)");
  lines.push("");
  lines.push(...tierA.lines);
  lines.push("");

  lines.push("## Tier B — elicitation vs. ground truth");
  lines.push("");
  lines.push(...tierB.lines);
  lines.push("");

  lines.push("## Tier C — spec quality (LLM judge, masked + order-swapped, 1-5 anchored rubric)");
  lines.push("");
  lines.push(...tierC.lines);
  lines.push("");

  lines.push(...tierDSection.lines);

  lines.push("## Success bar");
  lines.push("");
  lines.push("> " + SUCCESS_BAR_QUOTE);
  lines.push("");
  lines.push(`**Verdict: ${bar.verdict}**`);
  lines.push("");
  if (bar.verdict === "INSUFFICIENT-DATA") {
    for (const reason of bar.reasons) lines.push(`- ${reason}`);
  } else {
    lines.push(
      `- Token reduction: ${fmtPct(bar.tokenReductionPct)} (bar: >=30%) -- ${bar.tokensPass ? "PASS" : "FAIL"}`
    );
    lines.push(`- Tier C composite match-or-beat: ${bar.tierCPass ? "PASS" : "FAIL"}`);
    lines.push(
      `- User burden (lower-or-equal, informational -- does not gate the bar): ${
        bar.userBurdenPass === null ? "no usable data" : bar.userBurdenPass ? "PASS" : "FAIL"
      }`
    );
    lines.push(
      `- Tier D match-or-beat: ${bar.tierDPass === null ? "not run (not evaluated)" : bar.tierDPass ? "PASS" : "FAIL"}`
    );
  }
  lines.push("");

  lines.push("## Caveats");
  lines.push("");
  lines.push(
    `- **Pilot N.** This report covers ${scenarioCount} scenario(s)${
      pilot ? ", labeled **PILOT**" : ""
    }; spec section 13 targets N=15-20. Scaling the scenario corpus is a follow-up authoring task, not a claim this ` +
      "report makes."
  );
  lines.push(
    "- **Prose-mode variant.** Headless runs cannot answer AskUserQuestion; the driver instructs both workflows " +
      "to ask in numbered prose instead. Both sides run the same variant, but ideas' batching still shows as " +
      "fewer turns than a live AskUserQuestion session would."
  );
  lines.push(
    "- **Same-family judge.** The judge runs on a Claude model -- cross-family judging would need an external " +
      "API key this harness does not assume. Self-preference risk is mitigated by masking + order-swap only, " +
      "not by a different model family."
  );
  lines.push(
    "- **Sim-user relativity (\"Lost in Simulation\").** Results are a relative comparison of elicitation skill " +
      "between the two workflows, not a claim about absolute human usability; 2-3 scenarios must later be " +
      "validated with a real human user."
  );
  lines.push(
    "- **Token accounting is best-effort.** Counts come from the claude CLI's JSON usage field; a turn with " +
      "missing usage becomes null and is excluded from sums, never fabricated (see the n/dropped columns above)."
  );
  lines.push(
    "- **Pinned versions are best-effort.** ideas/superpowers plugin versions and model IDs are recorded from " +
      "config.json plus `claude plugin` output where feasible; unavailable values are recorded as null, never " +
      "guessed."
  );
  lines.push("");

  return lines.join("\n");
}

module.exports = {
  SUCCESS_BAR_QUOTE,
  PILOT_N_THRESHOLD,
  TOKEN_REDUCTION_BAR,
  TIER_A_METRICS,
  TIER_B_METRICS,
  minimumNeeded,
  computeScenarioMeans,
  evaluateSuccessBar,
  buildReport,
};
