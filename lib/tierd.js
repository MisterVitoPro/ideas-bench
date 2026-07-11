"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { buildAssistantInvocation, parseClaudeOutput, tryGitInit } = require("./driver");
const { DETERMINISM_INSTRUCTION, buildJudgeInvocation, stripCodeFence } = require("./judge");

// Tier D -- automated downstream outcome. Design spec section 13 names this
// the primary metric of the whole benchmark: "the same fixed executor
// implements from each spec with no access to the hidden doc; the held-out
// acceptance suite decides." This module drives that fixed-executor build +
// checklist-judge pipeline over already-`run` transcripts (see run.js's
// `run` command, which produces the transcript.json this module reads spec
// paths out of). It never talks to the scenario's hidden-doc.md -- only the
// spec a workflow already produced and the acceptance checklist.
//
// Per scenario x side (ideas, brainstorming), five steps:
//   1. selectSpecRun    -- pick the first run (1..config.runs_per_cell) whose
//                           transcript names a spec AND the file still exists.
//   2. buildSandbox      -- fresh workspace, git init best-effort, spec copied
//                           in as SPEC.md (line endings normalized).
//   3. runFixedExecutor  -- ONE claude -p call, pinned to
//                           config.interviewee_model, --permission-mode
//                           acceptEdits, prompt via stdin, cwd = sandbox.
//                           Reuses driver.js's buildAssistantInvocation /
//                           parseClaudeOutput -- the actual process spawning
//                           (claudeCliExec + buildSpawnPlan) is never
//                           reimplemented here; callers inject `exec`.
//   4. buildWorkspaceInventory + buildChecklistJudgePrompt -- ONE judge call,
//                           pinned to config.judge_model, over a bounded
//                           inventory of what got built.
//   5. parseChecklistJudgeResponse + computePass -- the pre-declared pass
//                           rule: a side passes iff every REQUIRED item's
//                           verdict is "pass". "unverifiable" never passes.
//
// Honesty invariants (matching the rest of this repo): a side's pass is
// `null` -- never guessed true/false -- whenever a spec was never produced,
// an executor/judge call failed, or the judge's JSON was malformed. Every
// null carries a `reason` string in the details record (see
// runTierDSide) so a null is always explainable, never a silent gap.

// --- step 1: spec selection --------------------------------------------------

// selectSpecRun({scenarioId, side, config, root}) -> {runIndex, specPath, specFullPath} | null
//
// Walks run1..config.runs_per_cell in order and returns the FIRST run whose
// transcript.json both names artifact.spec_path AND has that file actually
// present in that run's own workspace -- a transcript can claim
// spec-detected but the file could since have been removed, so both checks
// are required. No qualifying run in range returns null; callers record
// this honestly (reason: "no spec produced") rather than treating a missing
// spec as a build failure -- some scenario x side cells (e.g. s05 x
// brainstorming) are documented as plausibly never producing a spec at all.
function selectSpecRun({ scenarioId, side, config, root }) {
  const runsPerCell = typeof config.runs_per_cell === "number" ? config.runs_per_cell : 3;
  for (let runIndex = 1; runIndex <= runsPerCell; runIndex++) {
    const runDir = path.join(root, scenarioId, side, `run${runIndex}`);
    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(path.join(runDir, "transcript.json"), "utf8"));
    } catch {
      continue; // no transcript.json for this run index, or it's not valid JSON
    }
    const specPath =
      transcript && transcript.artifact && typeof transcript.artifact.spec_path === "string"
        ? transcript.artifact.spec_path
        : null;
    if (!specPath) continue;
    const specFullPath = path.join(runDir, "workspace", specPath);
    if (!fs.existsSync(specFullPath)) continue;
    return { runIndex, specPath, specFullPath };
  }
  return null;
}

// --- step 2: sandbox -----------------------------------------------------------

// buildSandbox({tierDRoot, scenarioId, side, specFullPath}) -> workspaceDir
//
// Fresh sandbox at <tierDRoot>/<scenarioId>/<side>/workspace -- always wiped
// and recreated first (a re-run must never inherit a stale build from a
// prior attempt, mirroring driver.js's ensureSandbox). git init is
// best-effort (reuses driver.js's tryGitInit rather than reimplementing
// spawn logic). The selected spec is copied in as SPEC.md with line endings
// normalized to LF, once, up front -- the fixed executor's entire prompt is
// "implement the specification in SPEC.md, in this workspace".
function buildSandbox({ tierDRoot, scenarioId, side, specFullPath }) {
  const workspaceDir = path.join(tierDRoot, scenarioId, side, "workspace");
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  tryGitInit(workspaceDir);
  // Ingestion seam: the spec was written by a prior sandboxed session and may
  // carry CRLF on a Windows checkout, matching the same normalization seam
  // driver.js/judge.js/run.js apply at every other point a spec's text is read.
  const specText = fs.readFileSync(specFullPath, "utf8").replace(/\r\n/g, "\n");
  fs.writeFileSync(path.join(workspaceDir, "SPEC.md"), specText);
  return workspaceDir;
}

// --- step 3: the fixed executor -------------------------------------------------

// Verbatim, fixed across every scenario x side -- this is what makes tier D a
// controlled comparison: the same executor, the same instruction, working
// only from whichever spec each workflow produced, with zero access to the
// scenario's hidden-doc.md.
const EXECUTOR_PROMPT =
  "Implement the specification in SPEC.md, in this workspace. Work only from the spec; where it is silent, " +
  "make reasonable choices and note them in IMPLEMENTATION-NOTES.md. Produce real, runnable code with tests " +
  "where the spec calls for them. Do not ask questions - there is no user.";

// runFixedExecutor({exec, model, workspaceDir}) -> Promise<{text, sessionId, usage}>
//
// Exactly one claude -p call: no --resume (this is a single-shot build, not
// a multi-turn interview session), pinned to config.interviewee_model, with
// --permission-mode acceptEdits so the executor can actually write files
// into the disposable sandbox (see driver.js's buildAssistantInvocation doc
// comment for why acceptEdits is required for headless writes). Reuses
// driver.js's buildAssistantInvocation/parseClaudeOutput directly rather
// than re-deriving the same {args, stdin} shape -- the real spawning
// (claudeCliExec + buildSpawnPlan) lives in driver.js and is never
// reimplemented here; `exec` is injected by the caller (the real CLI exec,
// or a scripted fake in tests/dry-run).
async function runFixedExecutor({ exec, model, workspaceDir }) {
  if (typeof exec !== "function") {
    throw new TypeError("tierd: exec must be an injectable executor function");
  }
  const { args, stdin } = buildAssistantInvocation({
    prompt: EXECUTOR_PROMPT,
    sessionId: null,
    model,
    permissionMode: "acceptEdits",
  });
  const { stdout } = await exec({ args, stdin, cwd: workspaceDir });
  return parseClaudeOutput(stdout);
}

// --- step 4: bounded workspace inventory ----------------------------------------

const PER_FILE_CAP = 6000;
const TOTAL_CAP = 40000;
// .git and node_modules are tooling artifacts, never "source/docs" -- excluded
// by directory name at any depth. SPEC.md is excluded by exact relative path:
// the judge must decide from what the executor BUILT, not re-read the spec it
// was already given verbatim as part of the checklist prompt.
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules"]);

function listInventoryFiles(workspaceDir) {
  const results = [];
  function walk(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const rel = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (rel === "SPEC.md") continue;
        results.push(rel);
      }
    }
  }
  walk(workspaceDir, "");
  return results;
}

// buildWorkspaceInventory(workspaceDir) -> {text, truncatedFiles, omittedFiles, fileCount}
//
// A bounded inventory of the sandbox the fixed executor built: a file tree
// followed by every file's contents, capped per-file (~6000 chars) and in
// total (~40000 chars) so the judge prompt stays a reasonable size no matter
// how much the executor produced. Files are read and (if needed) truncated
// in deterministic (alphabetical, depth-first) order; once the total cap is
// reached, remaining files are omitted entirely rather than silently
// dropped -- both truncatedFiles and omittedFiles are returned so the judge
// prompt can disclose the truncation honestly (see
// buildChecklistJudgePrompt) instead of presenting a partial view as
// complete.
function buildWorkspaceInventory(workspaceDir) {
  const files = listInventoryFiles(workspaceDir);
  const treeLines = files.length > 0 ? files.map((f) => `- ${f}`) : ["(no files found)"];

  const sections = [];
  const truncatedFiles = [];
  const omittedFiles = [];
  let totalUsed = 0;

  for (const rel of files) {
    if (totalUsed >= TOTAL_CAP) {
      omittedFiles.push(rel);
      continue;
    }
    let raw;
    try {
      // Ingestion seam: files were written by a sandboxed session and may
      // carry CRLF on a Windows checkout -- normalize before the judge ever
      // sees them, matching every other file-read seam in this repo.
      raw = fs.readFileSync(path.join(workspaceDir, rel), "utf8").replace(/\r\n/g, "\n");
    } catch (err) {
      sections.push(`### ${rel}\n(unreadable as text -- skipped: ${err.message})\n`);
      continue;
    }
    let text = raw;
    let truncated = false;
    if (text.length > PER_FILE_CAP) {
      text = text.slice(0, PER_FILE_CAP);
      truncated = true;
    }
    const remaining = TOTAL_CAP - totalUsed;
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    if (truncated) truncatedFiles.push(rel);
    totalUsed += text.length;
    sections.push(`### ${rel}${truncated ? " (truncated)" : ""}\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  const text = ["File tree:", treeLines.join("\n"), "", ...sections].join("\n");

  return { text, truncatedFiles, omittedFiles, fileCount: files.length };
}

// --- step 4b: checklist judge prompt + parse ------------------------------------

// countChecklistItems(acceptance) -> number of "- [ ] ..." bullet items
//
// Used only as a cross-check against the judge's returned item count (see
// parseChecklistJudgeResponse) -- this module never re-derives required/
// nice-to-have status itself; the judge does that from the checklist text
// it's given (see buildChecklistJudgePrompt's instruction), matching
// judge.js's pattern of never computing in the prompt what the judge is
// meant to decide.
const CHECKLIST_ITEM_RE = /^\s*-\s*\[ \]/gm;
function countChecklistItems(acceptance) {
  if (typeof acceptance !== "string") return 0;
  const matches = acceptance.match(CHECKLIST_ITEM_RE);
  return matches ? matches.length : 0;
}

// CHECKLIST_JUDGE_MARKER: the literal verdict-enum text emitted in every
// checklist judge prompt's output-format section. Exported so a scripted
// dry-run executor (see tier-d.js's makeDryRunExec) can distinguish a
// checklist-judge call from a fixed-executor call by inspecting the prompt,
// the same technique run.js's dry-run executor uses for its own judge
// prompts (see run.js's FACT_JUDGE_MARKER / DIMENSION_JUDGE_MARKER).
const CHECKLIST_JUDGE_MARKER = '"pass" | "fail" | "unverifiable"';

// buildChecklistJudgePrompt({acceptance, inventory}) -> string
//
// Carries the scenario's acceptance checklist verbatim and the bounded
// workspace inventory (step 4). The judge decides required/nice-to-have
// status itself from each item's text (items containing the literal
// "(Nice-to-have)" marker are optional; every other item is required) and
// returns one verdict per item -- this module never computes verdicts, only
// the pass rule over what the judge returns (see computePass).
function buildChecklistJudgePrompt({ acceptance, inventory }) {
  if (typeof acceptance !== "string" || acceptance.trim() === "") {
    throw new TypeError("tierd: buildChecklistJudgePrompt requires a non-empty acceptance checklist");
  }
  if (!inventory || typeof inventory.text !== "string") {
    throw new TypeError("tierd: buildChecklistJudgePrompt requires an inventory (see buildWorkspaceInventory)");
  }

  const truncationNotes = [];
  if (inventory.truncatedFiles.length > 0) {
    truncationNotes.push(
      `- ${inventory.truncatedFiles.length} file(s) truncated at ${PER_FILE_CAP} characters: ` +
        inventory.truncatedFiles.join(", ")
    );
  }
  if (inventory.omittedFiles.length > 0) {
    truncationNotes.push(
      `- ${inventory.omittedFiles.length} file(s) omitted entirely (total inventory cap of ${TOTAL_CAP} ` +
        `characters reached): ${inventory.omittedFiles.join(", ")}`
    );
  }

  return [
    "You are a strict, neutral acceptance-checklist judge for a downstream-outcome benchmark tier.",
    "A fixed, spec-only executor implemented a specification with no access to the hidden requirements " +
      "document behind it. You are given the scenario's held-out acceptance checklist and a bounded " +
      "inventory of the workspace that executor built. Decide, item by item, whether the built workspace " +
      "satisfies each checklist item.",
    DETERMINISM_INSTRUCTION,
    "",
    "Every checklist item below is either required or, when its text contains the literal marker " +
      '"(Nice-to-have)", optional. Preserve each item\'s exact text verbatim in your response, and set ' +
      '"required" to false for every item carrying that marker and true for every other item.',
    "",
    "For each item, decide exactly one verdict:",
    '  "pass"          -- the built workspace clearly satisfies this item',
    '  "fail"          -- the built workspace clearly does not satisfy this item',
    '  "unverifiable"  -- the inventory does not contain enough information to decide either way',
    "Base every decision only on the inventory provided below -- never assume something was built because " +
      "it seems like an obvious thing to include.",
    "",
    "## Acceptance checklist",
    acceptance.trim(),
    "",
    "## Built workspace inventory",
    inventory.text,
    "",
    truncationNotes.length > 0
      ? "## Inventory truncation notes (disclosed honestly -- judge only what is shown above)\n" +
        truncationNotes.join("\n")
      : "## Inventory truncation notes\n(none -- the full workspace content is shown above, within the caps)",
    "",
    "## Output format",
    "Respond with ONLY a single strict JSON object -- no markdown code fences, no commentary before or " +
      "after it -- matching exactly this shape:",
    '{"items": [{"text": "<checklist item text>", "required": true | false, ' +
      `"verdict": ${CHECKLIST_JUDGE_MARKER}}, ...]}`,
    'The "items" array must have exactly one entry for every checklist item listed above -- no more, no fewer.',
  ].join("\n");
}

// parseChecklistJudgeResponse(rawText, expectedCount) -> {ok: true, items} | {ok: false, error}
//
// Parses defensively: any structural problem (invalid JSON, wrong shape, a
// missing/invalid field on any item, an item count mismatch against the
// checklist) fails the WHOLE response -- never a partial guess for only the
// items that did parse. Callers must treat {ok: false} as "return null pass
// for this side, with the error note" per the repo's honesty invariant.
function parseChecklistJudgeResponse(rawText, expectedCount) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (err) {
    return { ok: false, error: `tierd: judge response was not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    return { ok: false, error: 'tierd: judge response must be an object with an "items" array' };
  }
  if (parsed.items.length === 0) {
    return { ok: false, error: "tierd: judge response items array must not be empty" };
  }
  if (typeof expectedCount === "number" && expectedCount > 0 && parsed.items.length !== expectedCount) {
    return {
      ok: false,
      error: `tierd: judge returned ${parsed.items.length} item(s) but the checklist has ${expectedCount}`,
    };
  }

  const validVerdicts = new Set(["pass", "fail", "unverifiable"]);
  const items = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const raw = parsed.items[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `tierd: items[${i}] must be an object` };
    }
    if (typeof raw.text !== "string" || raw.text.trim() === "") {
      return { ok: false, error: `tierd: items[${i}].text must be a non-empty string` };
    }
    if (typeof raw.required !== "boolean") {
      return { ok: false, error: `tierd: items[${i}].required must be a boolean` };
    }
    if (!validVerdicts.has(raw.verdict)) {
      return {
        ok: false,
        error: `tierd: items[${i}].verdict must be one of "pass"/"fail"/"unverifiable", got ${JSON.stringify(raw.verdict)}`,
      };
    }
    items.push({ text: raw.text, required: raw.required, verdict: raw.verdict });
  }

  return { ok: true, items };
}

// --- step 5: the pre-declared pass rule ------------------------------------------

// computePass(items) -> boolean
//
// A side passes iff EVERY required item's verdict is "pass". "unverifiable"
// is never a pass (it is not evidence the workspace satisfies the item), and
// a nice-to-have item's fail/unverifiable verdict never blocks a pass.
function computePass(items) {
  return Array.isArray(items) && items.every((it) => it.required !== true || it.verdict === "pass");
}

// --- orchestration: one side, then the full scenario x side matrix ---------------

const DEFAULT_JUDGE_CWD = os.tmpdir();

// runTierDSide({scenario, side, config, exec, root, tierDRoot}) -> Promise<SideResult>
//
// SideResult: {scenarioId, side, pass: bool|null, items: [...]|null,
//              specRun: number|null, specPath: string|null, reason: string|null}
//
// Drives the full per-side pipeline (steps 1-5 above). `pass` is null --
// never guessed -- whenever: no run produced a usable spec; the fixed
// executor call failed; the judge call failed; or the judge's JSON was
// malformed. Every null path sets `reason` to a human-readable explanation
// so a null in the results file is always traceable via the accompanying
// details file (see runTierD).
async function runTierDSide({ scenario, side, config, exec, root, tierDRoot }) {
  const scenarioId = scenario.id;

  const selected = selectSpecRun({ scenarioId, side, config, root });
  if (!selected) {
    return { scenarioId, side, pass: null, items: null, specRun: null, specPath: null, reason: "no spec produced" };
  }

  const workspaceDir = buildSandbox({ tierDRoot, scenarioId, side, specFullPath: selected.specFullPath });

  try {
    await runFixedExecutor({ exec, model: config.interviewee_model, workspaceDir });
  } catch (err) {
    return {
      scenarioId,
      side,
      pass: null,
      items: null,
      specRun: selected.runIndex,
      specPath: selected.specPath,
      reason: `tierd: fixed-executor call failed: ${err.message}`,
    };
  }

  const inventory = buildWorkspaceInventory(workspaceDir);
  const prompt = buildChecklistJudgePrompt({ acceptance: scenario.acceptance, inventory });
  const invocation = buildJudgeInvocation({ prompt, model: config.judge_model });

  let judgeText;
  try {
    const { stdout } = await exec({ args: invocation.args, stdin: invocation.stdin, cwd: DEFAULT_JUDGE_CWD });
    judgeText = parseClaudeOutput(stdout).text;
  } catch (err) {
    return {
      scenarioId,
      side,
      pass: null,
      items: null,
      specRun: selected.runIndex,
      specPath: selected.specPath,
      reason: `tierd: judge call failed: ${err.message}`,
    };
  }

  const expectedCount = countChecklistItems(scenario.acceptance);
  const parsed = parseChecklistJudgeResponse(judgeText, expectedCount);
  if (!parsed.ok) {
    return {
      scenarioId,
      side,
      pass: null,
      items: null,
      specRun: selected.runIndex,
      specPath: selected.specPath,
      reason: parsed.error,
    };
  }

  return {
    scenarioId,
    side,
    pass: computePass(parsed.items),
    items: parsed.items,
    specRun: selected.runIndex,
    specPath: selected.specPath,
    reason: null,
  };
}

// runTierD({scenarios, config, exec, root, tierDRoot}) -> Promise<{results, details}>
//
// Drives both sides (ideas, brainstorming) for every scenario, sequentially
// (deterministic call order, hermetically testable with a scripted fake
// executor). `results` is exactly the shape run.js's report expects for
// runs/tier-d-results.json: [{scenarioId, ideas_pass, brainstorming_pass}].
// `details` carries the full per-item audit trail (verdicts, spec run
// picked, failure reasons) for runs/tier-d-details.json -- never surfaced in
// the summary file, so the report's contract shape never drifts.
async function runTierD({ scenarios, config, exec, root, tierDRoot }) {
  const results = [];
  const details = [];
  for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
    const ideas = await runTierDSide({ scenario, side: "ideas", config, exec, root, tierDRoot });
    const brainstorming = await runTierDSide({ scenario, side: "brainstorming", config, exec, root, tierDRoot });
    results.push({ scenarioId: scenario.id, ideas_pass: ideas.pass, brainstorming_pass: brainstorming.pass });
    details.push({ scenarioId: scenario.id, ideas, brainstorming });
  }
  return { results, details };
}

module.exports = {
  EXECUTOR_PROMPT,
  CHECKLIST_JUDGE_MARKER,
  PER_FILE_CAP,
  TOTAL_CAP,
  selectSpecRun,
  buildSandbox,
  buildWorkspaceInventory,
  countChecklistItems,
  buildChecklistJudgePrompt,
  parseChecklistJudgeResponse,
  computePass,
  runFixedExecutor,
  runTierDSide,
  runTierD,
};
