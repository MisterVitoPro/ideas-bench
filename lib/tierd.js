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
//   2. buildSandbox      -- fresh workspace UNDER os.tmpdir() (never under
//                           runs/ -- see the doc comment on buildSandbox for
//                           the incident this fixes), git init best-effort,
//                           spec copied in as SPEC.md (line endings
//                           normalized).
//   3. runFixedExecutor  -- ONE claude -p call, pinned to
//                           config.interviewee_model, --permission-mode
//                           acceptEdits, prompt via stdin, cwd = sandbox.
//                           Reuses driver.js's buildAssistantInvocation /
//                           parseClaudeOutput -- the actual process spawning
//                           (claudeCliExec + buildSpawnPlan) is never
//                           reimplemented here; callers inject `exec`. The
//                           raw stdout is persisted to
//                           runs/tier-d/<scenario>/<side>/build-output.json
//                           for forensics (see writeBuildOutput).
//   4. buildWorkspaceInventory + buildChecklistJudgePrompt -- ONE judge call,
//                           pinned to config.judge_model, over a bounded
//                           inventory of what got built plus the full
//                           SPEC.md text the executor worked from. A bounded
//                           snapshot of the inventory is persisted to
//                           runs/tier-d/<scenario>/<side>/artifacts/ for
//                           audit (see writeArtifactSnapshot).
//   5. parseChecklistJudgeResponse + computePass -- the pre-declared pass
//                           rule: a side passes iff every REQUIRED item's
//                           verdict is "pass". "unverifiable" never passes.
//                           computeRequiredPassFraction additionally reports
//                           a graded required-items pass fraction alongside
//                           the binary pass, for a metric that doesn't floor
//                           two very-different near-misses to the same 0.
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

// buildSandbox({tmpRoot, scenarioId, side, specFullPath}) -> workspaceDir
//
// Fresh sandbox at <tmpRoot>/<scenarioId>/<side> -- always wiped and
// recreated first (a re-run must never inherit a stale build from a prior
// attempt, mirroring driver.js's ensureSandbox). git init is best-effort
// (reuses driver.js's tryGitInit rather than reimplementing spawn logic).
// The selected spec is copied in as SPEC.md with line endings normalized to
// LF, once, up front -- the fixed executor's entire prompt is "implement the
// specification in SPEC.md, in this workspace".
//
// `tmpRoot` MUST live outside the data tree (runs/ or runs-dry/) -- it is a
// per-invocation directory under os.tmpdir() that the caller creates once
// per `runTierD` run (see runTierD's tmpRoot) and scopes per scenario/side
// here. This is a deliberate isolation fix: an earlier version built
// directly under runs/tier-d/<scenario>/<side>/workspace, and a fixed
// executor's own build process (which can run arbitrary build/test tooling
// inside its cwd) once destroyed real run data (runs/s03..s05) that
// happened to sit nearby on a shared tree. The BUILD process's cwd must
// never again be inside runs/ -- only a bounded, read-only-after-the-fact
// artifact snapshot is copied back in (see writeArtifactSnapshot).
function buildSandbox({ tmpRoot, scenarioId, side, specFullPath }) {
  const workspaceDir = path.join(tmpRoot, scenarioId, side);
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

// runFixedExecutor({exec, model, workspaceDir}) -> Promise<{text, sessionId, usage, stdout}>
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
// or a scripted fake in tests/dry-run). The raw `stdout` is returned
// alongside the parsed fields so callers can persist it verbatim for
// forensics (see writeBuildOutput) -- a build session's raw output was
// previously discarded the moment it was parsed, leaving no audit trail for
// a build that "succeeded" per the CLI's JSON envelope but did something
// unexpected.
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
  return { ...parseClaudeOutput(stdout), stdout };
}

// writeBuildOutput({tierDRoot, scenarioId, side, execResult}) -> void
//
// Persists the fixed executor's raw CLI stdout and parsed text to
// runs/tier-d/<scenario>/<side>/build-output.json (runs-dry/ under
// --dry-run, since tierDRoot already differs per dry-run -- see
// tier-d.js's tierDRootFor). Closes the forensics gap: previously only the
// judge's verdicts were kept, so a build that misbehaved (wrote something
// unexpected, silently failed part-way, etc.) left no trace of what the
// executor actually said it did.
function writeBuildOutput({ tierDRoot, scenarioId, side, execResult }) {
  const dir = path.join(tierDRoot, scenarioId, side);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "build-output.json"),
    JSON.stringify(
      {
        stdout: execResult.stdout,
        text: execResult.text,
        sessionId: execResult.sessionId,
        usage: execResult.usage,
      },
      null,
      2
    ) + "\n"
  );
}

// writeArtifactSnapshot({tierDRoot, scenarioId, side, inventory}) -> void
//
// Copies the bounded workspace inventory (file tree listing + capped file
// contents -- see buildWorkspaceInventory) into
// runs/tier-d/<scenario>/<side>/artifacts/inventory.txt for audit. This is
// the ONLY thing that comes back from the tmp sandbox into the data tree --
// never the sandbox itself (see buildSandbox's doc comment on why the build
// process's cwd must stay outside runs/), and it is the exact same bounded
// text already built for the judge prompt, not a re-derivation of it.
function writeArtifactSnapshot({ tierDRoot, scenarioId, side, inventory }) {
  const dir = path.join(tierDRoot, scenarioId, side, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "inventory.txt"), inventory.text);
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

// buildChecklistJudgePrompt({acceptance, inventory, specText}) -> string
//
// Carries the scenario's acceptance checklist verbatim, the bounded
// workspace inventory (step 4), AND the full specification text the fixed
// executor worked from. The judge decides required/nice-to-have status
// itself from each item's text (items containing the literal
// "(Nice-to-have)" marker are optional; every other item is required) and
// returns one verdict per item -- this module never computes verdicts, only
// the pass rule over what the judge returns (see computePass).
//
// Fairness fix (analyst finding: class-D distortion + a grader
// inconsistency). Without the spec text, the judge could only ever look at
// what got BUILT -- so any checklist item describing a process, a rollout
// plan, or a compatibility promise (as opposed to built behavior) was
// unjudgeable from the inventory alone and either failed or came back
// unverifiable, no matter how explicitly a spec committed to it. Now the
// judge is given both the spec and the inventory, plus an explicit
// dual-standard instruction: built-behavior items are judged against the
// code, process/plan/rollout/compatibility items are judged against the
// spec's stated plan -- and the SAME standard is applied to whichever side
// produced the spec, so neither workflow is held to a stricter reading than
// the other.
function buildChecklistJudgePrompt({ acceptance, inventory, specText }) {
  if (typeof acceptance !== "string" || acceptance.trim() === "") {
    throw new TypeError("tierd: buildChecklistJudgePrompt requires a non-empty acceptance checklist");
  }
  if (!inventory || typeof inventory.text !== "string") {
    throw new TypeError("tierd: buildChecklistJudgePrompt requires an inventory (see buildWorkspaceInventory)");
  }
  if (typeof specText !== "string" || specText.trim() === "") {
    throw new TypeError(
      "tierd: buildChecklistJudgePrompt requires the full SPEC.md text given to the fixed executor"
    );
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
      "document behind it. You are given the specification the executor worked from, the scenario's " +
      "held-out acceptance checklist, and a bounded inventory of the workspace that executor built. Decide, " +
      "item by item, whether the checklist is satisfied.",
    DETERMINISM_INSTRUCTION,
    "",
    'Every checklist item in the "## Acceptance checklist" section below is either required or, when its ' +
      'text contains the literal marker "(Nice-to-have)", optional. Preserve each item\'s exact text ' +
      'verbatim in your response, and set "required" to false for every item carrying that marker and true ' +
      "for every other item.",
    "",
    "Apply exactly this dual judging standard, per item:",
    "  - An item describing BUILT BEHAVIOR (what the running code does; what files, APIs, or tests exist) " +
      'is judged strictly against the "## Built workspace inventory" below -- "pass" only if the built ' +
      "workspace actually does it. The specification's intentions are not evidence for this kind of item.",
    "  - An item describing a PROCESS, PLAN, ROLLOUT, OR COMPATIBILITY PROMISE (a staged rollout, a future " +
      'migration step, a deprecation timeline, or any other forward-looking commitment) is judged against ' +
      'the "## Specification" below, not the built code -- "pass" if the specification explicitly and ' +
      "credibly commits to it, even if the workspace does not yet implement it. Apply this exact same " +
      "standard no matter which side produced the specification -- never hold one side to a stricter " +
      "reading than the other.",
    "",
    "For each item, decide exactly one verdict:",
    '  "pass"          -- clearly satisfied, per whichever standard above applies to this item',
    '  "fail"          -- clearly not satisfied, per whichever standard above applies to this item',
    '  "unverifiable"  -- the material given below does not contain enough information to decide either way',
    "Base every decision only on the specification and inventory provided below -- never assume something " +
      "was built or promised because it seems like an obvious thing to include.",
    "",
    "## Specification given to the fixed executor (SPEC.md)",
    specText.trim(),
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
    'The "items" array must have exactly one entry for every checklist item listed in the "## Acceptance ' +
      'checklist" section above -- no more, no fewer, and never an item drawn from the specification or ' +
      "inventory sections.",
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

// computeRequiredPassFraction(items) -> number | null
//
// Graded companion to computePass (analyst finding: the binary pass rate
// floors every scenario to 0 or 1, so a side that nails 9 of 10 required
// items reads identically to a side that nails 0 of 10 -- a 0-vs-0 tie
// between two very different outcomes). Fraction of REQUIRED items whose
// verdict is "pass" -- nice-to-have items never enter the denominator, and
// "unverifiable" counts against the fraction exactly like "fail" (same
// honesty rule as computePass: unverifiable is never evidence of a pass).
// Returns null -- never 0, never 1 -- when items is null/not an array or
// there are zero required items, since a fraction of zero required items is
// undefined, not a real 0/1 outcome.
function computeRequiredPassFraction(items) {
  if (!Array.isArray(items)) return null;
  const required = items.filter((it) => it && it.required === true);
  if (required.length === 0) return null;
  const passing = required.filter((it) => it.verdict === "pass").length;
  return passing / required.length;
}

// --- orchestration: one side, then the full scenario x side matrix ---------------

const DEFAULT_JUDGE_CWD = os.tmpdir();

// runTierDSide({scenario, side, config, exec, root, tierDRoot, tmpRoot}) -> Promise<SideResult>
//
// SideResult: {scenarioId, side, pass: bool|null, items: [...]|null,
//              frac: number|null, specRun: number|null, specPath: string|null,
//              reason: string|null}
//
// Drives the full per-side pipeline (steps 1-5 above). `pass` is null --
// never guessed -- whenever: no run produced a usable spec; the fixed
// executor call failed; the judge call failed; or the judge's JSON was
// malformed. Every null path sets `reason` to a human-readable explanation
// so a null in the results file is always traceable via the accompanying
// details file (see runTierD). `frac` (see computeRequiredPassFraction)
// mirrors `pass`'s null-ness: it is only ever non-null when `items` is.
//
// `tmpRoot` is the sandbox's build root -- MUST be outside the data tree
// (see buildSandbox's doc comment). Callers driving a full runTierD matrix
// should create ONE tmpRoot for the whole invocation and pass it down (see
// runTierD); a caller invoking this function standalone (e.g. a unit test)
// gets a private one auto-created here, so isolation holds even without the
// caller remembering to supply it.
async function runTierDSide({ scenario, side, config, exec, root, tierDRoot, tmpRoot }) {
  const scenarioId = scenario.id;
  const effectiveTmpRoot = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), "ideas-bench-tierd-"));

  const selected = selectSpecRun({ scenarioId, side, config, root });
  if (!selected) {
    return {
      scenarioId,
      side,
      pass: null,
      items: null,
      frac: null,
      specRun: null,
      specPath: null,
      reason: "no spec produced",
    };
  }

  const workspaceDir = buildSandbox({ tmpRoot: effectiveTmpRoot, scenarioId, side, specFullPath: selected.specFullPath });

  let execResult;
  try {
    execResult = await runFixedExecutor({ exec, model: config.interviewee_model, workspaceDir });
  } catch (err) {
    return {
      scenarioId,
      side,
      pass: null,
      items: null,
      frac: null,
      specRun: selected.runIndex,
      specPath: selected.specPath,
      reason: `tierd: fixed-executor call failed: ${err.message}`,
    };
  }
  writeBuildOutput({ tierDRoot, scenarioId, side, execResult });

  const specText = fs.readFileSync(path.join(workspaceDir, "SPEC.md"), "utf8");
  const inventory = buildWorkspaceInventory(workspaceDir);
  writeArtifactSnapshot({ tierDRoot, scenarioId, side, inventory });

  const prompt = buildChecklistJudgePrompt({ acceptance: scenario.acceptance, inventory, specText });
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
      frac: null,
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
      frac: null,
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
    frac: computeRequiredPassFraction(parsed.items),
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
// runs/tier-d-results.json: [{scenarioId, ideas_pass, brainstorming_pass,
// ideas_frac, brainstorming_frac}] -- the two `_frac` fields are optional
// (null unless the judge returned items -- see computeRequiredPassFraction)
// and back-compat: a pre-existing tier-d-results.json without them still
// parses and reports the binary rate exactly as before (see report.js's
// buildTierDSection). `details` carries the full per-item audit trail
// (verdicts, spec run picked, failure reasons) for runs/tier-d-details.json
// -- never surfaced in the summary file, so the report's contract shape
// never drifts.
//
// Creates exactly ONE per-invocation build root under os.tmpdir() (see
// buildSandbox's doc comment on why builds must never run inside runs/) and
// reuses it for every scenario x side in this matrix -- one subdirectory
// per scenario/side underneath it. Removed best-effort at the end: this is
// disposable build scratch space, not part of the audit trail (the audit
// trail is the artifacts/ snapshot and build-output.json this function's
// per-side calls already wrote back under tierDRoot).
async function runTierD({ scenarios, config, exec, root, tierDRoot }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-bench-tierd-"));
  const results = [];
  const details = [];
  try {
    for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
      const ideas = await runTierDSide({ scenario, side: "ideas", config, exec, root, tierDRoot, tmpRoot });
      const brainstorming = await runTierDSide({
        scenario,
        side: "brainstorming",
        config,
        exec,
        root,
        tierDRoot,
        tmpRoot,
      });
      results.push({
        scenarioId: scenario.id,
        ideas_pass: ideas.pass,
        brainstorming_pass: brainstorming.pass,
        ideas_frac: ideas.frac,
        brainstorming_frac: brainstorming.frac,
      });
      details.push({ scenarioId: scenario.id, ideas, brainstorming });
    }
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of disposable build scratch space -- never fails the run
    }
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
  computeRequiredPassFraction,
  runFixedExecutor,
  runTierDSide,
  runTierD,
};
