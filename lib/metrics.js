"use strict";
const os = require("node:os");

const { parseClaudeOutput } = require("./driver");
const {
  DIMENSIONS,
  buildJudgeInvocation,
  buildFactJudgePrompt,
  parseFactJudgeResponse,
  maskSpec,
  buildDimensionJudgePrompt,
  parseDimensionJudgeResponse,
} = require("./judge");

// Default cwd for judge exec calls: judge calls never read or write files
// (unlike the driver's assistant/sim-user calls, which run inside the
// sandbox workspace), so any writable directory works. os.tmpdir() keeps
// judge calls from ever touching the repo.
const DEFAULT_JUDGE_CWD = os.tmpdir();

// --- tier A: deterministic, no model calls ----------------------------------

// countQuestions(text) -> number of questions asked in one assistant turn.
//
// Heuristic (documented here because it's a heuristic, not ground truth):
//   1. Every numbered-list line ending in "?" (e.g. "1. What flag name?")
//      counts as one question. These lines are removed from the text before
//      step 2 so their trailing "?" is never double-counted.
//   2. Every remaining "sentence" ending in "?" -- i.e. every run of
//      non-terminator characters immediately followed by "?" -- counts as
//      one more question, as long as it contains at least one word
//      character (so a stray "?" with no content isn't counted). This
//      catches inline/prose questions the assistant didn't bother to number,
//      e.g. "Should it also support Windows? And macOS?" (2 questions).
// This is an approximation: it will over-count rhetorical questions and
// under-count questions phrased without a "?" (e.g. "Let me know the flag
// name."). It is exported specifically so it can be tested in isolation.
const NUMBERED_QUESTION_LINE = /^\s*\d+[.)]\s+.+\?\s*$/gm;

function countQuestions(text) {
  if (typeof text !== "string") return 0;
  const numberedLines = text.match(NUMBERED_QUESTION_LINE) || [];
  const remainder = text.replace(NUMBERED_QUESTION_LINE, "");
  const sentenceQuestions = (remainder.match(/[^.!?\n]*\?/g) || []).filter((s) => /\w/.test(s));
  return numberedLines.length + sentenceQuestions.length;
}

function usableOutputTokens(turn) {
  return turn && turn.usage && typeof turn.usage.output_tokens === "number" ? turn.usage.output_tokens : null;
}

// approxTokenCount(text) -> number
//
// Approximate token count: text length / 4, a commonly used rough
// heuristic when no real tokenizer is available. Rounded to the nearest
// integer. Never fabricated as an exact count -- callers must label any
// metric built from this as approximate (see tierA's user_burden_tokens).
function approxTokenCount(text) {
  const len = typeof text === "string" ? text.length : 0;
  return Math.round(len / 4);
}

// tierA(transcript) -> {output_tokens, output_tokens_complete, turns, questions_asked, user_burden_tokens}
//
// Fully deterministic from the transcript -- no model calls. Mirrors the
// same best-effort token-accounting honesty rule used throughout the
// harness: output_tokens sums only turns with usable (non-null) usage;
// output_tokens_complete is true only when every turn in the transcript
// reported usage (and false, not vacuously true, for a zero-turn
// transcript -- there is no coverage to claim when nothing ran).
//
// user_burden_tokens is explicitly approximate (see approxTokenCount): the
// sum of every user turn's text length, divided by 4.
function tierA(transcript) {
  const turns = transcript && Array.isArray(transcript.turns) ? transcript.turns : [];

  const usages = turns.map(usableOutputTokens);
  const output_tokens = usages.reduce((sum, v) => sum + (v === null ? 0 : v), 0);
  const output_tokens_complete = turns.length > 0 && usages.every((v) => v !== null);

  const questions_asked = turns
    .filter((t) => t.role === "assistant")
    .reduce((sum, t) => sum + countQuestions(t.text), 0);

  const userChars = turns
    .filter((t) => t.role === "user")
    .reduce((sum, t) => sum + (typeof t.text === "string" ? t.text.length : 0), 0);
  const user_burden_tokens = Math.round(userChars / 4);

  return { output_tokens, output_tokens_complete, turns: turns.length, questions_asked, user_burden_tokens };
}

// --- tier B: one judge call, local arithmetic -------------------------------

function nullTierB(error) {
  return {
    facts: null,
    active_pct: null,
    critical_coverage: null,
    silent_assumptions: null,
    flagged_assumptions: null,
    error,
  };
}

// tierB({scenario, transcript, spec, exec, model, cwd}) -> Promise<TierBResult>
//
// Makes exactly ONE judge call. The judge returns a strict JSON mapping of
// fact id -> "active" | "passive" | "missed" (never computing any
// aggregate itself); active_pct (over all facts) and critical_coverage
// (over "critical"-weight facts, counting active OR passive as elicited)
// are then computed locally here, from that mapping only.
//
// Parses defensively: any executor failure or malformed judge response
// returns a whole-result null (facts/active_pct/critical_coverage/
// assumption lists all null) plus an error note -- never a partial guess.
async function tierB({ scenario, transcript, spec, exec, model, cwd }) {
  if (typeof exec !== "function") {
    throw new TypeError("tierB: exec must be an injectable executor function");
  }
  if (!scenario || !scenario.meta || !Array.isArray(scenario.meta.facts)) {
    throw new TypeError("tierB: scenario.meta.facts must be an array");
  }

  const prompt = buildFactJudgePrompt({ scenario, transcript, spec });
  const invocation = buildJudgeInvocation({ prompt, model });

  let stdout;
  try {
    const result = await exec({ args: invocation.args, stdin: invocation.stdin, cwd: cwd || DEFAULT_JUDGE_CWD });
    stdout = result.stdout;
  } catch (err) {
    return nullTierB(`tierB: judge executor call failed: ${err.message}`);
  }

  let judgeText;
  try {
    judgeText = parseClaudeOutput(stdout).text;
  } catch (err) {
    return nullTierB(`tierB: judge CLI output was not valid JSON: ${err.message}`);
  }

  const parsed = parseFactJudgeResponse(judgeText, scenario.meta.facts);
  if (!parsed.ok) {
    return nullTierB(parsed.error);
  }

  const facts = scenario.meta.facts.map((f) => ({ id: f.id, elicited: parsed.factMap[f.id] }));
  const activeCount = facts.filter((f) => f.elicited === "active").length;
  const active_pct = facts.length > 0 ? activeCount / facts.length : null;

  const criticalFacts = scenario.meta.facts.filter((f) => f.weight === "critical");
  const criticalElicited = criticalFacts.filter((f) => {
    const elicited = parsed.factMap[f.id];
    return elicited === "active" || elicited === "passive";
  }).length;
  const critical_coverage = criticalFacts.length > 0 ? criticalElicited / criticalFacts.length : null;

  return {
    facts,
    active_pct,
    critical_coverage,
    silent_assumptions: parsed.silent_assumptions,
    flagged_assumptions: parsed.flagged_assumptions,
    error: null,
  };
}

// --- tier C: masked, order-swapped, per-dimension judging -------------------

// runJudgeCall({dimension, docFirst, docSecond, exec, model, cwd}) -> Promise<{ok, document_1, document_2, error}>
async function runJudgeCall({ dimension, docFirst, docSecond, exec, model, cwd }) {
  const prompt = buildDimensionJudgePrompt({ dimension, doc1: docFirst, doc2: docSecond });
  const invocation = buildJudgeInvocation({ prompt, model });

  let stdout;
  try {
    const result = await exec({ args: invocation.args, stdin: invocation.stdin, cwd: cwd || DEFAULT_JUDGE_CWD });
    stdout = result.stdout;
  } catch (err) {
    return { ok: false, error: `tierC: judge executor call failed: ${err.message}` };
  }

  let judgeText;
  try {
    judgeText = parseClaudeOutput(stdout).text;
  } catch (err) {
    return { ok: false, error: `tierC: judge CLI output was not valid JSON: ${err.message}` };
  }

  return parseDimensionJudgeResponse(judgeText);
}

// judgeDimension({dimension, specA, specB, exec, model, cwd, random}) -> Promise<DimensionResult>
//
// Runs exactly two isolated calls for this one dimension: one presenting
// [specA, specB] and one presenting the swapped [specB, specA] -- so every
// dimension is judged with both orderings regardless of which physical
// spec the (injectable, defaults to Math.random) `random` function happens
// to place first. Both raw per-call orderings and scores are kept in the
// output for audit. If either call fails or returns a malformed response,
// the WHOLE dimension (both A and B) is null with an error note -- an
// average built from only one successful call would itself be a guess.
async function judgeDimension({ dimension, specA, specB, exec, model, cwd, random }) {
  const rand = typeof random === "function" ? random : Math.random;
  const aFirst = rand() < 0.5;
  const order1 = aFirst ? ["A", "B"] : ["B", "A"];
  const order2 = aFirst ? ["B", "A"] : ["A", "B"];
  const docs = { A: specA, B: specB };

  const call1 = await runJudgeCall({
    dimension,
    docFirst: docs[order1[0]],
    docSecond: docs[order1[1]],
    exec,
    model,
    cwd,
  });
  const call2 = await runJudgeCall({
    dimension,
    docFirst: docs[order2[0]],
    docSecond: docs[order2[1]],
    exec,
    model,
    cwd,
  });

  const raw = [
    {
      order: order1,
      document_1: call1.ok ? call1.document_1 : null,
      document_2: call1.ok ? call1.document_2 : null,
      error: call1.ok ? null : call1.error,
    },
    {
      order: order2,
      document_1: call2.ok ? call2.document_1 : null,
      document_2: call2.ok ? call2.document_2 : null,
      error: call2.ok ? null : call2.error,
    },
  ];

  if (!call1.ok || !call2.ok) {
    const errors = [call1.ok ? null : call1.error, call2.ok ? null : call2.error].filter(Boolean);
    return { A: null, B: null, raw, error: errors.join("; ") };
  }

  // Map each call's document_1/document_2 back to A/B using that call's
  // own order, then average across the two calls.
  const scoresOf = (order, result) => ({ [order[0]]: result.document_1, [order[1]]: result.document_2 });
  const s1 = scoresOf(order1, call1);
  const s2 = scoresOf(order2, call2);

  return {
    A: (s1.A + s2.A) / 2,
    B: (s1.B + s2.B) / 2,
    raw,
    error: null,
  };
}

// tierC({specA, specB, exec, model, cwd, random}) -> Promise<{completeness, unambiguity, testability, consistency, assumption_honesty}>
//
// Both specs are masked (see judge.js maskSpec) once, up front, then reused
// across all 5 dimensions x 2 orderings = 10 isolated judge calls, each at
// (approximated -- see judge.js's DETERMINISM_INSTRUCTION) temperature 0.
// Dimensions run sequentially, not in parallel, so call order is
// deterministic and hermetically testable with a scripted fake executor.
async function tierC({ specA, specB, exec, model, cwd, random }) {
  if (typeof exec !== "function") {
    throw new TypeError("tierC: exec must be an injectable executor function");
  }

  const maskedA = maskSpec(specA);
  const maskedB = maskSpec(specB);

  const result = {};
  for (const dimension of DIMENSIONS) {
    result[dimension] = await judgeDimension({
      dimension,
      specA: maskedA,
      specB: maskedB,
      exec,
      model,
      cwd,
      random,
    });
  }
  return result;
}

module.exports = {
  tierA,
  tierB,
  tierC,
  countQuestions,
  approxTokenCount,
};
