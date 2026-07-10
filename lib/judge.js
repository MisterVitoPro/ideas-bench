"use strict";

// Judge-specific prompt building, response parsing, and spec masking shared
// by tier B (fact-matching) and tier C (pairwise spec judging) in
// metrics.js. Every function here is pure -- no exec calls, no fs access --
// so it can be unit tested directly without a scripted executor.
//
// Judge calls are single-shot `claude -p --output-format json --model <m>`
// invocations (see buildJudgeInvocation): no --resume, no session
// continuity, matching the same {args, stdin} shape driver.js's assistant
// and sim-user calls use.
//
// Temperature note: the claude CLI's `-p --output-format json` mode does
// not expose a --temperature (or any sampling-control) flag as of this
// writing. There is therefore no mechanism to pass an actual temperature-0
// setting through argv. Every judge prompt instead asks the model in words
// to answer as deterministically as possible; this is a best-effort
// approximation, not a guarantee, and is recorded here (and must be
// recorded in the bench report) rather than silently assumed.
const DETERMINISM_INSTRUCTION =
  "Answer as deterministically as possible: judge only the material facts in front of you, do not hedge, " +
  "and do not let stylistic flourish or answer order influence your judgment. " +
  "(Note: the CLI this judge runs through exposes no temperature/sampling control -- this instruction is the " +
  "only lever available to approximate temperature-0 behavior.)";

// buildJudgeInvocation({prompt, model}) -> {args, stdin}
//
// Stateless single-shot judge call. Every judge invocation (tier B's one
// fact-matching call, tier C's ten per-scenario dimension calls) goes
// through this same shape.
function buildJudgeInvocation({ prompt, model }) {
  if (typeof model !== "string" || model.trim() === "") {
    throw new TypeError("judge: model must be a non-empty string (pass config.judge_model)");
  }
  if (typeof prompt !== "string" || prompt === "") {
    throw new TypeError("judge: prompt must be a non-empty string");
  }
  return { args: ["-p", "--output-format", "json", "--model", model], stdin: prompt };
}

// --- tier B: fact-matching prompt + parse -----------------------------------

function formatTranscriptForJudge(transcript) {
  const turns = transcript && Array.isArray(transcript.turns) ? transcript.turns : [];
  if (turns.length === 0) return "(empty transcript -- no turns were recorded)";
  return turns.map((t) => `${t.role === "assistant" ? "ASSISTANT" : "USER"}: ${t.text}`).join("\n\n");
}

// buildFactJudgePrompt({scenario, transcript, spec}) -> string
//
// Carries the scenario's planted facts (id + text + weight) and latent
// constraints, the full transcript, and the spec text produced (if any).
// Instructs the judge to return strict JSON mapping every fact id to
// exactly one of "active" | "passive" | "missed", plus the silent vs
// flagged assumption lists. The judge never computes active_pct or
// critical_coverage -- that arithmetic happens locally in metrics.js from
// the returned mapping.
function buildFactJudgePrompt({ scenario, transcript, spec }) {
  if (!scenario || !scenario.meta || !Array.isArray(scenario.meta.facts)) {
    throw new TypeError("judge: buildFactJudgePrompt requires scenario.meta.facts");
  }
  const facts = scenario.meta.facts.map((f) => `- ${f.id} [${f.weight}]: ${f.text}`).join("\n");
  const latent = Array.isArray(scenario.meta.latent) && scenario.meta.latent.length > 0
    ? scenario.meta.latent.map((l) => `- ${l}`).join("\n")
    : "(none recorded)";

  return [
    "You are a strict, neutral fact-matching judge for a requirements-elicitation benchmark.",
    "You are given a list of planted facts (each with an id and a weight), a list of latent constraints " +
      "the user only reveals if directly asked, the full transcript of an interview between an AI assistant " +
      "and a simulated user, and the final spec the assistant produced.",
    DETERMINISM_INSTRUCTION,
    "",
    "For every planted fact below, decide exactly one of:",
    '  "active"  -- the fact was surfaced because the assistant asked a question that elicited it',
    '  "passive" -- the user volunteered or let the fact slip without being asked for it',
    '  "missed"  -- the fact never appears, surfaced or volunteered, anywhere in the transcript or the spec',
    "Base every decision only on the transcript and spec text provided below -- never assume a fact was " +
      "covered because it seems like an obvious thing to cover.",
    "",
    "Also identify, as free-text quotes or close paraphrases of spec statements:",
    '  "silent_assumptions" -- statements in the spec that assert something not established anywhere in the ' +
      "transcript, presented as settled fact without being flagged as an assumption",
    '  "flagged_assumptions" -- statements in the spec that assert something not established in the ' +
      'transcript, but that the spec itself explicitly calls out as an assumption (e.g. under an ' +
      '"Assumptions" heading or similar) rather than asserting it as settled fact',
    "",
    "## Planted facts",
    facts,
    "",
    "## Latent constraints",
    latent,
    "",
    "## Transcript",
    formatTranscriptForJudge(transcript),
    "",
    "## Final spec",
    typeof spec === "string" && spec.trim() !== "" ? spec.trim() : "(no spec was produced in this run)",
    "",
    "## Output format",
    "Respond with ONLY a single strict JSON object -- no markdown code fences, no commentary before or " +
      "after it -- matching exactly this shape:",
    '{"facts": {"<fact id>": "active" | "passive" | "missed", ...}, ' +
      '"silent_assumptions": ["...", ...], "flagged_assumptions": ["...", ...]}',
    "The \"facts\" object must have exactly one entry for every planted fact id listed above -- no more, no fewer.",
  ].join("\n");
}

// stripCodeFence(text) -> string
//
// Judges are instructed to reply with bare JSON, but models sometimes wrap
// it in a ```json fence anyway. Strips one such fence if present; otherwise
// returns the trimmed text unchanged.
function stripCodeFence(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

const VALID_ELICITED = new Set(["active", "passive", "missed"]);

// parseFactJudgeResponse(rawText, expectedFacts) -> {ok: true, factMap, silent_assumptions, flagged_assumptions}
//                                                  | {ok: false, error}
//
// Parses defensively: any structural problem (invalid JSON, wrong shape,
// a missing/invalid fact id, an unexpected extra fact id, missing
// assumption arrays) fails the WHOLE response -- never a partial guess for
// only the facts that did parse. Callers must treat {ok: false} as "return
// null for tier B, with the error note" per the honesty invariant.
function parseFactJudgeResponse(rawText, expectedFacts) {
  const expectedIds = Array.isArray(expectedFacts) ? expectedFacts.map((f) => f.id) : [];

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (err) {
    return { ok: false, error: `judge: tier B response was not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "judge: tier B response must be a JSON object" };
  }

  const factMap = parsed.facts;
  if (!factMap || typeof factMap !== "object" || Array.isArray(factMap)) {
    return { ok: false, error: 'judge: tier B response is missing a "facts" object' };
  }

  const violations = [];
  for (const id of expectedIds) {
    const v = factMap[id];
    if (!VALID_ELICITED.has(v)) {
      violations.push(`fact "${id}" has an invalid or missing elicited value (${JSON.stringify(v)})`);
    }
  }
  const expectedSet = new Set(expectedIds);
  const extraKeys = Object.keys(factMap).filter((k) => !expectedSet.has(k));
  if (extraKeys.length > 0) {
    violations.push(`facts object has unexpected keys not in the planted fact list: ${extraKeys.join(", ")}`);
  }
  if (!Array.isArray(parsed.silent_assumptions)) {
    violations.push('missing "silent_assumptions" array');
  }
  if (!Array.isArray(parsed.flagged_assumptions)) {
    violations.push('missing "flagged_assumptions" array');
  }

  if (violations.length > 0) {
    return { ok: false, error: `judge: malformed tier B response -- ${violations.join("; ")}` };
  }

  return {
    ok: true,
    factMap,
    silent_assumptions: parsed.silent_assumptions,
    flagged_assumptions: parsed.flagged_assumptions,
  };
}

// --- tier C: masking, dimension prompt + parse ------------------------------

// A line is treated as a workflow-identifying title/header when it's the
// document's leading H1 -- both workflows produce a top title line, and its
// exact wording/format is exactly the kind of tell masking must remove.
const LEADING_TITLE_RE = /^#\s+.+$/;

// normalizeSectionOrder(body) -> string
//
// Splits the (already de-titled) body on "## " headings and sorts the
// resulting sections alphabetically by heading text. This is a trivial,
// meaning-preserving reordering -- no section's content is touched, only
// their relative position -- that removes one more structural tell (the two
// workflows may conventionally order sections differently, which would
// otherwise let a judge guess provenance from structure alone rather than
// content). Any preamble before the first "## " heading (e.g. a one-line
// summary directly under the stripped title) is kept in place at the top.
function normalizeSectionOrder(body) {
  const parts = body.split(/(?=^##\s+.+$)/m);
  const preamble = parts.length > 0 && !/^##\s+/.test(parts[0]) ? parts.shift() : "";
  const sections = parts.map((text) => {
    const heading = (text.match(/^##\s+(.+)$/m) || [null, ""])[1].trim().toLowerCase();
    return { heading, text };
  });
  sections.sort((a, b) => a.heading.localeCompare(b.heading));
  return (preamble + sections.map((s) => s.text).join("")).trim() + "\n";
}

// maskSpec(specText) -> string
//
// Strips the leading title/header line identifying provenance, then
// normalizes section ordering (see normalizeSectionOrder). Applied to BOTH
// specs before every tier C dimension call so the judge sees only content,
// never a workflow-branded title or a structurally telling section order.
function maskSpec(specText) {
  if (typeof specText !== "string") return "";
  const lines = specText.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length > 0 && LEADING_TITLE_RE.test(lines[0])) lines.shift();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  return normalizeSectionOrder(lines.join("\n"));
}

const DIMENSION_DESCRIPTIONS = {
  completeness:
    "How completely does the spec cover what a competent engineer would need to implement the feature " +
    "correctly, leaving nothing important to guess at?",
  unambiguity:
    "How free of ambiguity is the spec -- how unlikely is it that two different engineers, reading only " +
    "this document, would build materially different things?",
  testability:
    "How testable are the spec's requirements -- can each one be turned into a concrete pass/fail check?",
  consistency:
    "How internally consistent is the spec -- are there no contradictions between different parts of it?",
  assumption_honesty:
    "How honestly does the spec handle assumptions -- does it explicitly flag anything it assumes rather " +
    "than silently asserting unconfirmed things as settled fact?",
};

const DIMENSIONS = Object.freeze(Object.keys(DIMENSION_DESCRIPTIONS));

// buildDimensionJudgePrompt({dimension, doc1, doc2}) -> string
//
// One isolated call judges exactly one dimension for exactly one ordering
// of exactly two (already-masked) documents. Documents are labeled
// "Document 1" / "Document 2" -- never "A" / "B" -- so the anonymized
// framing carries no residual labeling bias. Explicitly states that length
// is not quality.
function buildDimensionJudgePrompt({ dimension, doc1, doc2 }) {
  const description = DIMENSION_DESCRIPTIONS[dimension];
  if (!description) {
    throw new RangeError(`judge: unknown tier C dimension "${dimension}"`);
  }
  return [
    "You are a strict, neutral judge comparing two requirements specs on exactly one dimension.",
    "The two specs have been anonymized -- titles and any workflow-identifying headers have been removed, " +
      "and their section order has been normalized. Judge only the content in front of you.",
    DETERMINISM_INSTRUCTION,
    "",
    `Dimension: ${dimension}`,
    description,
    "",
    "Length is not quality: a longer document is not automatically more complete, less ambiguous, more " +
      "testable, more internally consistent, or more honest about its assumptions. Judge substance, not " +
      "word count.",
    "",
    "## Document 1",
    doc1,
    "",
    "## Document 2",
    doc2,
    "",
    "## Output format",
    "Respond with ONLY a single strict JSON object -- no markdown code fences, no commentary -- matching " +
      "exactly this shape:",
    '{"document_1": <integer 1-5>, "document_2": <integer 1-5>}',
  ].join("\n");
}

// parseDimensionJudgeResponse(rawText) -> {ok: true, document_1, document_2} | {ok: false, error}
function parseDimensionJudgeResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (err) {
    return { ok: false, error: `judge: tier C response was not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "judge: tier C response must be a JSON object" };
  }
  const isValidScore = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
  const d1 = parsed.document_1;
  const d2 = parsed.document_2;
  if (!isValidScore(d1) || !isValidScore(d2)) {
    return {
      ok: false,
      error:
        "judge: tier C response scores must be integers 1-5, got " +
        `document_1=${JSON.stringify(d1)} document_2=${JSON.stringify(d2)}`,
    };
  }
  return { ok: true, document_1: d1, document_2: d2 };
}

module.exports = {
  DIMENSIONS,
  DIMENSION_DESCRIPTIONS,
  DETERMINISM_INSTRUCTION,
  buildJudgeInvocation,
  buildFactJudgePrompt,
  parseFactJudgeResponse,
  formatTranscriptForJudge,
  maskSpec,
  normalizeSectionOrder,
  buildDimensionJudgePrompt,
  parseDimensionJudgeResponse,
  stripCodeFence,
};
