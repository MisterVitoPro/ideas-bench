"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { tierA, tierB, tierC, countQuestions, approxTokenCount } = require("../lib/metrics");
const {
  DIMENSIONS,
  buildJudgeInvocation,
  buildFactJudgePrompt,
  parseFactJudgeResponse,
  maskSpec,
  buildDimensionJudgePrompt,
  parseDimensionJudgeResponse,
} = require("../lib/judge");
const { createFakeExec } = require("../fixtures/fake-cli");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "transcript-pair");

function loadJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, rel), "utf8"));
}
function loadText(rel) {
  return fs.readFileSync(path.join(FIXTURES_DIR, rel), "utf8");
}

const TRANSCRIPT_A = loadJSON("transcript-a.json"); // good elicitation: mixed active/passive/missed
const TRANSCRIPT_B = loadJSON("transcript-b.json"); // poor elicitation: mostly missed, has a null-usage turn
const SPEC_HONEST = loadText("spec-honest.md"); // has a flagged "## Assumptions" section
const SPEC_SILENT = loadText("spec-silent.md"); // silently asserts unresolved ambiguities as fact
const SCENARIO = {
  id: "fx-netfetch-timeout",
  title: "Add a --timeout flag to the netfetch CLI",
  domain: "CLI feature",
  hiddenDoc: loadText("scenario/hidden-doc.md"),
  acceptance: loadText("scenario/acceptance.md"),
  meta: loadJSON("scenario/meta.json"),
};

const JUDGE_MODEL = "claude-opus-4-8";

function jsonStep(payload, usage) {
  return { text: JSON.stringify(payload), usage: usage === undefined ? { output_tokens: 20 } : usage };
}

// =============================================================================
// EARS 1: tierA is deterministic from the transcript, no model calls, and
// marks output_tokens_complete false if any turn's usage is null.
// =============================================================================

test("countQuestions counts numbered-question lines and inline sentence questions without double-counting", () => {
  assert.strictEqual(countQuestions("1. What flag name?\n2. What date format?\nNot a question."), 2);
  assert.strictEqual(countQuestions("Should it support Windows? And macOS?"), 2);
  assert.strictEqual(countQuestions("Just a statement, no questions here."), 0);
  assert.strictEqual(countQuestions("1. Numbered one? Also inline text with no mark here."), 1);
  assert.strictEqual(countQuestions(""), 0);
  assert.strictEqual(countQuestions(undefined), 0);
  assert.strictEqual(countQuestions(null), 0);
});

test("countQuestions ignores a stray run of '?' with no word content", () => {
  assert.strictEqual(countQuestions("???"), 0);
});

test("tierA computed from the good-elicitation fixture transcript: exact tokens/turns/questions, complete usage", () => {
  const result = tierA(TRANSCRIPT_A);
  assert.strictEqual(result.turns, TRANSCRIPT_A.turns.length);
  assert.strictEqual(result.turns, 6);
  assert.strictEqual(result.output_tokens_complete, true, "every turn in transcript-a.json carries usage");

  const expectedTokens = TRANSCRIPT_A.turns.reduce((sum, t) => sum + t.usage.output_tokens, 0);
  assert.strictEqual(result.output_tokens, expectedTokens);

  // 4 numbered questions in the first assistant turn, 3 in the second, 0 in the third.
  assert.strictEqual(result.questions_asked, 7);

  const expectedUserChars = TRANSCRIPT_A.turns
    .filter((t) => t.role === "user")
    .reduce((sum, t) => sum + t.text.length, 0);
  assert.strictEqual(result.user_burden_tokens, Math.round(expectedUserChars / 4));
});

test("tierA marks output_tokens_complete false when any turn's usage is null (poor-elicitation fixture)", () => {
  const result = tierA(TRANSCRIPT_B);
  assert.strictEqual(result.output_tokens_complete, false);
  // The null-usage turn (user turn 2, "Sure, sounds fine.") contributes 0, not a guess.
  const expectedTokens = TRANSCRIPT_B.turns.reduce(
    (sum, t) => sum + (t.usage && typeof t.usage.output_tokens === "number" ? t.usage.output_tokens : 0),
    0
  );
  assert.strictEqual(result.output_tokens, expectedTokens);
  assert.strictEqual(result.turns, 4);
  assert.strictEqual(result.questions_asked, 1);
});

test("tierA on a zero-turn transcript reports output_tokens_complete false, not vacuously true", () => {
  const result = tierA({ turns: [] });
  assert.strictEqual(result.turns, 0);
  assert.strictEqual(result.output_tokens_complete, false);
  assert.strictEqual(result.output_tokens, 0);
  assert.strictEqual(result.questions_asked, 0);
  assert.strictEqual(result.user_burden_tokens, 0);
});

test("approxTokenCount is length/4 rounded, and is explicitly labeled approximate (never fabricated as exact)", () => {
  assert.strictEqual(approxTokenCount("abcd"), 1);
  assert.strictEqual(approxTokenCount(""), 0);
  assert.strictEqual(approxTokenCount(null), 0);
  assert.strictEqual(approxTokenCount("abcdefg"), 2); // 7/4 = 1.75 -> rounds to 2
});

// =============================================================================
// tierB: exactly one judge call, defensive parsing, local arithmetic
// =============================================================================

test("tierB makes exactly one exec call carrying the facts, latent constraints, transcript and spec", async () => {
  const factMap = { f1: "active", f2: "active", f3: "active", f4: "active", f5: "passive", f6: "missed", f7: "active", f8: "active" };
  const exec = createFakeExec([
    jsonStep({
      facts: factMap,
      silent_assumptions: [],
      flagged_assumptions: [
        "We assume --timeout applies to the whole multi-file download as a single clock",
      ],
    }),
  ]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST, exec, model: JUDGE_MODEL });

  assert.strictEqual(exec.calls.length, 1, "tierB makes exactly one judge call");
  const call = exec.calls[0];
  assert.ok(call.args.includes("--model"));
  assert.strictEqual(call.args[call.args.indexOf("--model") + 1], JUDGE_MODEL);
  assert.ok(!call.args.includes("--resume"), "the judge call is stateless -- never resumes a session");

  // The prompt (on stdin, never argv) carries every planted fact id+text+weight,
  // the latent constraint, the transcript dialogue, and the spec text.
  for (const fact of SCENARIO.meta.facts) {
    assert.ok(call.stdin.includes(fact.id), `prompt includes fact id ${fact.id}`);
    assert.ok(call.stdin.includes(fact.text), `prompt includes fact text for ${fact.id}`);
  }
  assert.ok(call.stdin.includes(SCENARIO.meta.latent[0]), "prompt includes the latent constraint");
  assert.ok(call.stdin.includes("netfetch is our internal Node CLI"), "prompt includes real transcript dialogue");
  assert.ok(call.stdin.includes("## Assumptions"), "prompt includes the spec text");

  // Local arithmetic: active_pct over ALL facts, critical_coverage over
  // critical-weight facts only (active OR passive counts as elicited).
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.active_pct, 6 / 8);
  assert.strictEqual(result.critical_coverage, 1); // f1-f4 are the 4 critical facts, all active
  assert.deepStrictEqual(
    result.facts.find((f) => f.id === "f5"),
    { id: "f5", elicited: "passive" }
  );
  assert.deepStrictEqual(
    result.facts.find((f) => f.id === "f6"),
    { id: "f6", elicited: "missed" }
  );
  assert.deepStrictEqual(result.flagged_assumptions, [
    "We assume --timeout applies to the whole multi-file download as a single clock",
  ]);
  assert.deepStrictEqual(result.silent_assumptions, []);
});

test("tierB distinguishes silent_assumptions from flagged_assumptions using the contrasting fixture specs", async () => {
  const factMap = Object.fromEntries(SCENARIO.meta.facts.map((f) => [f.id, "missed"]));
  const exec = createFakeExec([
    jsonStep({
      facts: factMap,
      silent_assumptions: ["The timeout applies to each individual request separately."],
      flagged_assumptions: [],
    }),
  ]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_B, spec: SPEC_SILENT, exec, model: JUDGE_MODEL });

  assert.strictEqual(result.error, null);
  assert.strictEqual(result.active_pct, 0);
  assert.strictEqual(result.critical_coverage, 0);
  assert.deepStrictEqual(result.silent_assumptions, ["The timeout applies to each individual request separately."]);
  assert.deepStrictEqual(result.flagged_assumptions, []);
});

test("tierB returns null (whole result) with an error note when the executor call fails -- never a guess", async () => {
  const exec = createFakeExec([{ error: "claude CLI exited with code 1: simulated failure" }]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST, exec, model: JUDGE_MODEL });

  assert.strictEqual(result.facts, null);
  assert.strictEqual(result.active_pct, null);
  assert.strictEqual(result.critical_coverage, null);
  assert.strictEqual(result.silent_assumptions, null);
  assert.strictEqual(result.flagged_assumptions, null);
  assert.match(result.error, /executor call failed/);
});

test("tierB returns null (whole result) with an error note when the judge JSON is malformed -- never a partial guess", async () => {
  const exec = createFakeExec([{ text: "not valid json {{{ at all" }]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST, exec, model: JUDGE_MODEL });

  assert.strictEqual(result.facts, null);
  assert.strictEqual(result.active_pct, null);
  assert.strictEqual(result.critical_coverage, null);
  assert.match(result.error, /not valid JSON/);
});

test("tierB returns null with an error note when the judge omits a planted fact id (partial mapping rejected)", async () => {
  const incompleteMap = { f1: "active" }; // missing f2..f8
  const exec = createFakeExec([jsonStep({ facts: incompleteMap, silent_assumptions: [], flagged_assumptions: [] })]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST, exec, model: JUDGE_MODEL });

  assert.strictEqual(result.active_pct, null);
  assert.match(result.error, /f2/);
});

test("tierB tolerates a ```json code-fenced judge response", async () => {
  const factMap = Object.fromEntries(SCENARIO.meta.facts.map((f) => [f.id, "active"]));
  const fenced = "```json\n" + JSON.stringify({ facts: factMap, silent_assumptions: [], flagged_assumptions: [] }) + "\n```";
  const exec = createFakeExec([{ text: fenced, usage: { output_tokens: 20 } }]);

  const result = await tierB({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST, exec, model: JUDGE_MODEL });

  assert.strictEqual(result.error, null);
  assert.strictEqual(result.active_pct, 1);
});

// =============================================================================
// EARS 2 + 3: tierC masks headers, order-swaps + averages, records both raw
// orderings, and isolates a failed/malformed dimension to null without
// affecting the other four.
// =============================================================================

function scoreStep(document_1, document_2) {
  return jsonStep({ document_1, document_2 });
}

// honest/silent score per dimension; call1 presents [B(silent), A(honest)]
// and call2 presents [A(honest), B(silent)] given RANDOM_B_FIRST below, so
// call1 = (silentScore, honestScore) and call2 = (honestScore, silentScore).
const DIMENSION_SCORES = [
  ["completeness", 5, 3],
  ["unambiguity", 4, 3],
  ["testability", 4, 2],
  ["consistency", 5, 4],
  ["assumption_honesty", 5, 2],
];

function honestSilentScript() {
  const steps = [];
  for (const [, honest, silent] of DIMENSION_SCORES) {
    steps.push(scoreStep(silent, honest));
    steps.push(scoreStep(honest, silent));
  }
  return steps;
}

// rand() < 0.5 is false for every call -> aFirst=false -> order1=["B","A"], order2=["A","B"].
const RANDOM_B_FIRST = () => 0.9;

test("tierC masks workflow-identifying titles before judging (spec-honest.md / spec-silent.md fixtures)", () => {
  const maskedHonest = maskSpec(SPEC_HONEST);
  const maskedSilent = maskSpec(SPEC_SILENT);

  assert.ok(!maskedHonest.includes("ideas:interview"), "the /ideas:interview title tell is stripped");
  assert.ok(!maskedSilent.includes("superpowers:brainstorming"), "the brainstorming title tell is stripped");
  assert.ok(!/^#\s/m.test(maskedHonest), "no H1 (single '#') title line survives masking");
  assert.ok(!/^#\s/m.test(maskedSilent), "no H1 (single '#') title line survives masking");

  // Content is preserved -- masking never drops a requirement, only the title/order.
  assert.ok(maskedHonest.includes("code 124"));
  assert.ok(maskedSilent.includes("each individual request separately"));

  // Section order is normalized to alphabetical -- masked honest has 3
  // sections (Assumptions, Out of scope, Requirements); alphabetically
  // "Assumptions" sorts first, so it must appear before "## Requirements".
  const assumptionsIdx = maskedHonest.indexOf("## Assumptions");
  const requirementsIdx = maskedHonest.indexOf("## Requirements");
  assert.ok(assumptionsIdx >= 0 && requirementsIdx >= 0 && assumptionsIdx < requirementsIdx);
});

test("tierC judges all 5 dimensions, each order-swapped and averaged, recording both raw orderings", async () => {
  const exec = createFakeExec(honestSilentScript());

  const result = await tierC({
    specA: SPEC_HONEST,
    specB: SPEC_SILENT,
    exec,
    model: JUDGE_MODEL,
    random: RANDOM_B_FIRST,
  });

  assert.strictEqual(exec.calls.length, 10, "5 dimensions x 2 order-swapped calls = 10 isolated judge calls");
  assert.deepStrictEqual(Object.keys(result).sort(), [...DIMENSIONS].sort());
  assert.deepStrictEqual(Object.keys(result).sort(), [
    "assumption_honesty",
    "completeness",
    "consistency",
    "testability",
    "unambiguity",
  ]);

  for (const [dimension, honest, silent] of DIMENSION_SCORES) {
    const dim = result[dimension];
    assert.strictEqual(dim.error, null, `${dimension} has no error`);
    assert.strictEqual(dim.A, honest, `${dimension}.A is spec A's (honest) averaged score`);
    assert.strictEqual(dim.B, silent, `${dimension}.B is spec B's (silent) averaged score`);

    assert.strictEqual(dim.raw.length, 2, `${dimension} keeps both raw orderings`);
    assert.deepStrictEqual(dim.raw[0].order, ["B", "A"]);
    assert.strictEqual(dim.raw[0].document_1, silent);
    assert.strictEqual(dim.raw[0].document_2, honest);
    assert.deepStrictEqual(dim.raw[1].order, ["A", "B"]);
    assert.strictEqual(dim.raw[1].document_1, honest);
    assert.strictEqual(dim.raw[1].document_2, silent);
  }

  // Every call was single-shot and pinned to the judge model, never resuming.
  for (const call of exec.calls) {
    assert.ok(!call.args.includes("--resume"));
    assert.strictEqual(call.args[call.args.indexOf("--model") + 1], JUDGE_MODEL);
  }
  // Masked prompts never leak the workflow-identifying titles into the judge call.
  for (const call of exec.calls) {
    assert.ok(!call.stdin.includes("ideas:interview"));
    assert.ok(!call.stdin.includes("superpowers:brainstorming"));
  }
});

test("tierC states length is not quality in every dimension prompt", () => {
  const prompt = buildDimensionJudgePrompt({ dimension: "completeness", doc1: "short", doc2: "long".repeat(500) });
  assert.match(prompt, /[Ll]ength is not quality/);
});

// Carried note from the Task 4 review: judge.js's dimension descriptions were
// one-liners; design spec section 13 requires "anchored rubric levels" for
// tier C. Every dimension prompt must ground the judge with anchors for the
// worst (1), middle (3), and best (5) levels -- pinned here so the anchors
// can never silently regress back to bare one-liners.
test("every tier C dimension prompt contains anchored rubric levels for 1, 3, and 5", () => {
  const { DIMENSION_DESCRIPTIONS } = require("../lib/judge");
  for (const dimension of DIMENSIONS) {
    const prompt = buildDimensionJudgePrompt({ dimension, doc1: "Document one text.", doc2: "Document two text." });
    assert.match(prompt, /Score anchors/i, `${dimension} prompt introduces score anchors`);
    for (const level of [1, 3, 5]) {
      const anchorText = DIMENSION_DESCRIPTIONS[dimension].anchors[level];
      assert.ok(
        typeof anchorText === "string" && anchorText.length > 0,
        `${dimension} has a non-empty anchor for level ${level}`
      );
      assert.ok(!anchorText.includes("\n"), `${dimension} level ${level} anchor is one line`);
      assert.ok(prompt.includes(anchorText), `${dimension} prompt includes its level ${level} anchor text verbatim`);
      assert.match(prompt, new RegExp(`${level} -- `), `${dimension} prompt labels level ${level} explicitly`);
    }
  }
});

test("tierC isolates a failed dimension to null+error without affecting the other four", async () => {
  const steps = honestSilentScript();
  // "consistency" is DIMENSION_SCORES[3] -> steps[6] and steps[7]; fail its first call.
  steps[6] = { error: "claude CLI exited with code 1: simulated judge failure" };

  const exec = createFakeExec(steps);
  const result = await tierC({ specA: SPEC_HONEST, specB: SPEC_SILENT, exec, model: JUDGE_MODEL, random: RANDOM_B_FIRST });

  assert.strictEqual(result.consistency.A, null);
  assert.strictEqual(result.consistency.B, null);
  assert.match(result.consistency.error, /simulated judge failure/);
  // The second call for the failed dimension still ran (both calls always
  // fire) and its outcome is still recorded in raw for audit.
  assert.strictEqual(result.consistency.raw.length, 2);
  assert.match(result.consistency.raw[0].error, /simulated judge failure/);
  assert.strictEqual(result.consistency.raw[1].error, null);

  // The other 4 dimensions are unaffected.
  for (const [dimension, honest, silent] of DIMENSION_SCORES) {
    if (dimension === "consistency") continue;
    assert.strictEqual(result[dimension].A, honest);
    assert.strictEqual(result[dimension].B, silent);
    assert.strictEqual(result[dimension].error, null);
  }
});

test("tierC isolates a malformed dimension response to null+error without affecting the other four", async () => {
  const steps = honestSilentScript();
  steps[6] = { text: "not valid json for this dimension", usage: { output_tokens: 5 } };

  const exec = createFakeExec(steps);
  const result = await tierC({ specA: SPEC_HONEST, specB: SPEC_SILENT, exec, model: JUDGE_MODEL, random: RANDOM_B_FIRST });

  assert.strictEqual(result.consistency.A, null);
  assert.strictEqual(result.consistency.B, null);
  assert.match(result.consistency.error, /not valid JSON/);

  for (const [dimension, honest, silent] of DIMENSION_SCORES) {
    if (dimension === "consistency") continue;
    assert.strictEqual(result[dimension].A, honest);
    assert.strictEqual(result[dimension].B, silent);
  }
});

// =============================================================================
// judge.js: pure prompt-building / parsing / masking unit coverage
// =============================================================================

test("buildJudgeInvocation requires a non-empty model and prompt (never silently defaults the judge model)", () => {
  assert.throws(() => buildJudgeInvocation({ prompt: "x", model: "" }), /model/);
  assert.throws(() => buildJudgeInvocation({ prompt: "x", model: undefined }), /model/);
  assert.throws(() => buildJudgeInvocation({ prompt: "", model: "m" }), /prompt/);
  const invocation = buildJudgeInvocation({ prompt: "hello", model: "claude-opus-4-8" });
  assert.deepStrictEqual(invocation.args, ["-p", "--output-format", "json", "--model", "claude-opus-4-8"]);
  assert.strictEqual(invocation.stdin, "hello");
});

test("buildFactJudgePrompt embeds fact weights and instructs strict-JSON, active/passive/missed output", () => {
  const prompt = buildFactJudgePrompt({ scenario: SCENARIO, transcript: TRANSCRIPT_A, spec: SPEC_HONEST });
  assert.match(prompt, /"active" \| "passive" \| "missed"/);
  assert.match(prompt, /f1 \[critical\]/);
  assert.match(prompt, /f5 \[nice\]/);
});

test("parseFactJudgeResponse rejects an out-of-vocabulary elicited value", () => {
  const bad = parseFactJudgeResponse(
    JSON.stringify({
      facts: Object.fromEntries(SCENARIO.meta.facts.map((f) => [f.id, "sort-of"])),
      silent_assumptions: [],
      flagged_assumptions: [],
    }),
    SCENARIO.meta.facts
  );
  assert.strictEqual(bad.ok, false);
});

test("parseFactJudgeResponse rejects an unexpected extra fact id", () => {
  const facts = Object.fromEntries(SCENARIO.meta.facts.map((f) => [f.id, "missed"]));
  facts.fZZZ = "active";
  const bad = parseFactJudgeResponse(
    JSON.stringify({ facts, silent_assumptions: [], flagged_assumptions: [] }),
    SCENARIO.meta.facts
  );
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /fZZZ/);
});

test("parseDimensionJudgeResponse rejects out-of-range and non-integer scores", () => {
  assert.strictEqual(parseDimensionJudgeResponse(JSON.stringify({ document_1: 6, document_2: 3 })).ok, false);
  assert.strictEqual(parseDimensionJudgeResponse(JSON.stringify({ document_1: 2.5, document_2: 3 })).ok, false);
  assert.strictEqual(parseDimensionJudgeResponse(JSON.stringify({ document_1: 0, document_2: 3 })).ok, false);
  assert.strictEqual(parseDimensionJudgeResponse("{ this is not json").ok, false);
  const ok = parseDimensionJudgeResponse(JSON.stringify({ document_1: 3, document_2: 4 }));
  assert.deepStrictEqual(ok, { ok: true, document_1: 3, document_2: 4 });
});

// =============================================================================
// EARS 4: everything above runs hermetically -- no network, only fixtures and
// createFakeExec. This test asserts the fixture pair itself has real,
// non-trivial content differences the metrics above actually exercised.
// =============================================================================

test("the fixture pair has genuinely different content -- not interchangeable placeholders", () => {
  assert.notStrictEqual(SPEC_HONEST, SPEC_SILENT);
  assert.ok(SPEC_HONEST.includes("## Assumptions"), "the honest spec has a flagged Assumptions section");
  assert.ok(!SPEC_SILENT.includes("## Assumptions"), "the silent spec has no Assumptions section at all");
  assert.notStrictEqual(TRANSCRIPT_A.turns.length, TRANSCRIPT_B.turns.length);
  assert.ok(tierA(TRANSCRIPT_A).questions_asked > tierA(TRANSCRIPT_B).questions_asked);
});
