"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EXECUTOR_PROMPT,
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
  runTierDSide,
  runTierD,
} = require("../lib/tierd");
const { createFakeExec } = require("../fixtures/fake-cli");

const BENCH_ROOT = path.join(__dirname, "..");
// Every path below is scoped under runs-dry/tierd-lib-test/ -- lib-level
// tests never touch the real runs/ tree, matching driver.test.js's own
// RUNS_ROOT convention (see the comment there on why that separation
// matters: a shared root once caused a test cleanup hook to delete real run
// data).
const ROOT = path.join(BENCH_ROOT, "runs-dry", "tierd-lib-test");
const TIERD_ROOT = path.join(ROOT, "tier-d");
fs.mkdirSync(ROOT, { recursive: true });

// Sandboxes now build OUTSIDE the data tree entirely (see lib/tierd.js's
// buildSandbox doc comment on the incident this fixes) -- this is the one
// tmpRoot every buildSandbox-level test in this file shares, itself safely
// scoped under os.tmpdir() and cleaned up at test.after like ROOT above.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-bench-tierd-test-"));

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// --- test fixtures -----------------------------------------------------------

const ACCEPTANCE = [
  "# Acceptance checklist -- test scenario",
  "",
  "- [ ] Required item one.",
  "- [ ] Required item two.",
  "- [ ] (Nice-to-have) optional item.",
  "",
].join("\n");

function makeScenario(id) {
  return {
    id,
    title: "A test scenario for tier D",
    domain: "test",
    hiddenDoc: "irrelevant to tier D -- the fixed executor never sees this",
    acceptance: ACCEPTANCE,
    meta: { id, title: "A test scenario for tier D", domain: "test", facts: [], ambiguities: [], latent: [] },
  };
}

const CONFIG = {
  interviewee_model: "claude-sonnet-5",
  judge_model: "claude-opus-4-8",
  runs_per_cell: 3,
};

// writeTranscript(root, scenarioId, side, runIndex, {specPath, specContent}) -> void
//
// Writes a minimal transcript.json (only the fields selectSpecRun reads) plus,
// when specPath is given, the spec file itself inside that run's workspace --
// exactly what run.js's `run` command would have produced.
function writeTranscript(root, scenarioId, side, runIndex, { specPath, specContent } = {}) {
  const runDir = path.join(root, scenarioId, side, `run${runIndex}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "transcript.json"),
    JSON.stringify({ artifact: { spec_path: specPath || null } }, null, 2)
  );
  if (specPath) {
    const specFullPath = path.join(runDir, "workspace", specPath);
    fs.mkdirSync(path.dirname(specFullPath), { recursive: true });
    fs.writeFileSync(specFullPath, specContent || "# Spec\n\nGenerated for a tier D test.\n");
  }
}

function mkTmpWorkspace(name) {
  const dir = path.join(TIERD_ROOT, "tmp-workspaces", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// =============================================================================
// selectSpecRun -- spec-selection fallback
// =============================================================================

test("selectSpecRun picks the first run whose transcript names a spec AND the file exists, skipping runs that don't qualify", () => {
  const scenarioId = "sel-fallback";
  const side = "ideas";
  // run1: transcript exists but names no spec at all.
  writeTranscript(ROOT, scenarioId, side, 1, {});
  // run2: transcript names a spec AND the file is really there -- this is the one.
  writeTranscript(ROOT, scenarioId, side, 2, { specPath: "docs/specs/run2-spec.md", specContent: "# run2 spec\n" });
  // run3: transcript names a spec but the file was never actually written (stale claim).
  writeTranscript(ROOT, scenarioId, side, 3, { specPath: "docs/specs/never-written.md" });
  fs.rmSync(path.join(ROOT, scenarioId, side, "run3", "workspace", "docs", "specs", "never-written.md"), {
    force: true,
  });

  const result = selectSpecRun({ scenarioId, side, config: CONFIG, root: ROOT });
  assert.strictEqual(result.runIndex, 2);
  assert.strictEqual(result.specPath, "docs/specs/run2-spec.md");
  assert.ok(fs.existsSync(result.specFullPath));
});

test("selectSpecRun returns null when no run in range (1..runs_per_cell) has a usable spec", () => {
  const scenarioId = "sel-none";
  const side = "brainstorming";
  writeTranscript(ROOT, scenarioId, side, 1, {}); // no spec named
  // run2/run3: no transcript.json at all.

  const result = selectSpecRun({ scenarioId, side, config: CONFIG, root: ROOT });
  assert.strictEqual(result, null);
});

test("selectSpecRun returns null when the scenario/side has no run directories on disk whatsoever", () => {
  const result = selectSpecRun({ scenarioId: "sel-never-run", side: "ideas", config: CONFIG, root: ROOT });
  assert.strictEqual(result, null);
});

// =============================================================================
// buildSandbox -- fresh workspace OUTSIDE the data tree, spec copied in as
// SPEC.md, CRLF normalized (isolation fix: an earlier version built directly
// under runs/tier-d/<scenario>/<side>/workspace, and a fixed executor's own
// build tooling once destroyed real run data (runs/s03..s05) that happened
// to sit nearby on that shared tree).
// =============================================================================

test("buildSandbox builds OUTSIDE the data tree, under the caller's tmpRoot", () => {
  const scenarioId = "sbx-isolation";
  writeTranscript(ROOT, scenarioId, "ideas", 1, { specPath: "docs/specs/a.md", specContent: "# A\n" });
  const selected = selectSpecRun({ scenarioId, side: "ideas", config: CONFIG, root: ROOT });

  const workspaceDir = buildSandbox({ tmpRoot: TMP_ROOT, scenarioId, side: "ideas", specFullPath: selected.specFullPath });

  assert.ok(workspaceDir.startsWith(TMP_ROOT), "sandbox lives under the supplied tmpRoot");
  assert.ok(!workspaceDir.includes(path.sep + "runs" + path.sep), "sandbox path never runs through a runs/ segment");
  assert.ok(!workspaceDir.includes(path.sep + "runs-dry" + path.sep), "sandbox path never runs through a runs-dry/ segment");
  assert.ok(fs.existsSync(path.join(workspaceDir, "SPEC.md")));
});

test("buildSandbox copies the spec in as SPEC.md with CRLF normalized to LF", () => {
  const scenarioId = "sbx-crlf";
  writeTranscript(ROOT, scenarioId, "ideas", 1, {
    specPath: "docs/specs/crlf-spec.md",
    specContent: "# Spec\r\nLine two\r\nLine three\r\n",
  });
  const selected = selectSpecRun({ scenarioId, side: "ideas", config: CONFIG, root: ROOT });

  const workspaceDir = buildSandbox({ tmpRoot: TMP_ROOT, scenarioId, side: "ideas", specFullPath: selected.specFullPath });

  const specText = fs.readFileSync(path.join(workspaceDir, "SPEC.md"), "utf8");
  assert.strictEqual(specText, "# Spec\nLine two\nLine three\n");
  assert.ok(!specText.includes("\r"), "no stray \\r survives normalization");
});

test("buildSandbox wipes a stale prior build before copying in the new spec", () => {
  const scenarioId = "sbx-stale";
  writeTranscript(ROOT, scenarioId, "ideas", 1, { specPath: "docs/specs/a.md", specContent: "# A\n" });
  const selected = selectSpecRun({ scenarioId, side: "ideas", config: CONFIG, root: ROOT });

  const first = buildSandbox({ tmpRoot: TMP_ROOT, scenarioId, side: "ideas", specFullPath: selected.specFullPath });
  fs.writeFileSync(path.join(first, "leftover-from-attempt-one.txt"), "stale build artifact");
  assert.ok(fs.existsSync(path.join(first, "leftover-from-attempt-one.txt")));

  const second = buildSandbox({ tmpRoot: TMP_ROOT, scenarioId, side: "ideas", specFullPath: selected.specFullPath });
  assert.strictEqual(second, first, "same sandbox path across rebuilds");
  assert.ok(!fs.existsSync(path.join(second, "leftover-from-attempt-one.txt")), "stale file was wiped");
  assert.ok(fs.existsSync(path.join(second, "SPEC.md")), "SPEC.md is still (re-)written");
});

// =============================================================================
// buildWorkspaceInventory -- exclusions, caps, truncation honesty
// =============================================================================

test("buildWorkspaceInventory excludes SPEC.md, .git/, and node_modules/, and includes other source/docs files", () => {
  const ws = mkTmpWorkspace("exclusions");
  fs.writeFileSync(path.join(ws, "SPEC.md"), "# spec -- must never appear in the inventory");
  fs.mkdirSync(path.join(ws, ".git"));
  fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main");
  fs.mkdirSync(path.join(ws, "node_modules", "somepkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "somepkg", "index.js"), "module.exports = {};");
  fs.writeFileSync(path.join(ws, "IMPLEMENTATION-NOTES.md"), "Assumed defaults per the spec's silence.");
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "index.js"), "module.exports = function main() {};");

  const inv = buildWorkspaceInventory(ws);

  assert.strictEqual(inv.fileCount, 2, "only IMPLEMENTATION-NOTES.md and src/index.js count");
  assert.ok(!inv.text.includes("SPEC.md"), "SPEC.md never appears in the inventory");
  assert.ok(!inv.text.includes(".git"), ".git/ contents never appear in the inventory");
  assert.ok(!inv.text.includes("node_modules"), "node_modules/ contents never appear in the inventory");
  assert.ok(inv.text.includes("IMPLEMENTATION-NOTES.md"));
  assert.ok(inv.text.includes("src/index.js"));
  assert.ok(inv.text.includes("Assumed defaults per the spec's silence."));
});

test("buildWorkspaceInventory truncates an oversized file at PER_FILE_CAP and records it honestly", () => {
  const ws = mkTmpWorkspace("per-file-cap");
  fs.writeFileSync(path.join(ws, "big.txt"), "x".repeat(PER_FILE_CAP + 500));

  const inv = buildWorkspaceInventory(ws);

  assert.deepStrictEqual(inv.truncatedFiles, ["big.txt"]);
  assert.strictEqual(inv.omittedFiles.length, 0);
  assert.ok(inv.text.includes("big.txt (truncated)"));
});

test("buildWorkspaceInventory omits files entirely once TOTAL_CAP is reached and records them honestly", () => {
  const ws = mkTmpWorkspace("total-cap");
  // 7 files each exactly PER_FILE_CAP chars (so none is truncated on its
  // own) sum to 42000, past TOTAL_CAP (40000) -- alphabetically, the first 6
  // (36000 chars) fit whole, the 7th gets truncated to the remaining 4000,
  // and the 8th (sorted last) must be entirely omitted, never truncated.
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(ws, `f${i}.txt`), "x".repeat(PER_FILE_CAP));
  }
  fs.writeFileSync(path.join(ws, "f7-omitted.txt"), "should never appear in the inventory at all");

  const inv = buildWorkspaceInventory(ws);

  assert.ok(inv.omittedFiles.includes("f7-omitted.txt"));
  assert.ok(
    !inv.text.includes("should never appear in the inventory at all"),
    "an omitted file's content never leaks into the inventory text"
  );
});

test("buildWorkspaceInventory on an empty workspace (besides SPEC.md) reports zero files, not an error", () => {
  const ws = mkTmpWorkspace("empty");
  fs.writeFileSync(path.join(ws, "SPEC.md"), "# spec only, nothing built");

  const inv = buildWorkspaceInventory(ws);
  assert.strictEqual(inv.fileCount, 0);
  assert.match(inv.text, /no files found/);
});

// =============================================================================
// countChecklistItems / buildChecklistJudgePrompt
// =============================================================================

test("countChecklistItems counts every '- [ ] ...' bullet, including nice-to-haves", () => {
  assert.strictEqual(countChecklistItems(ACCEPTANCE), 3);
  assert.strictEqual(countChecklistItems("no bullets here"), 0);
  assert.strictEqual(countChecklistItems(null), 0);
});

const SPEC_TEXT = "# Spec\n\nA staged rollout: phase 1 ships behind a flag, phase 2 removes the flag next release.\n";

test("buildChecklistJudgePrompt embeds the checklist verbatim, the inventory, and discloses truncation honestly", () => {
  const inv = { text: "File tree:\n- a.txt\n", truncatedFiles: ["a.txt"], omittedFiles: ["b.txt"], fileCount: 2 };
  const prompt = buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv, specText: SPEC_TEXT });

  assert.ok(prompt.includes("Required item one."));
  assert.ok(prompt.includes("(Nice-to-have)"));
  assert.match(prompt, /1 file\(s\) truncated/);
  assert.match(prompt, /1 file\(s\) omitted entirely/);
  assert.match(prompt, /"pass" \| "fail" \| "unverifiable"/);
});

test("buildChecklistJudgePrompt reports no truncation when the inventory has none", () => {
  const inv = { text: "File tree:\n- a.txt\n", truncatedFiles: [], omittedFiles: [], fileCount: 1 };
  const prompt = buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv, specText: SPEC_TEXT });
  assert.match(prompt, /none -- the full workspace content is shown above/);
});

// =============================================================================
// FIX (analyst: class-D distortion + a grader inconsistency) -- the judge
// prompt now carries the full spec text and a dual judging standard so
// process/plan/rollout/compatibility checklist items are judged against the
// spec's stated plan rather than unjudgeable from the built inventory alone.
// =============================================================================

test("buildChecklistJudgePrompt embeds the full SPEC.md text given to the fixed executor", () => {
  const inv = { text: "File tree:\n- a.txt\n", truncatedFiles: [], omittedFiles: [], fileCount: 1 };
  const prompt = buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv, specText: SPEC_TEXT });

  assert.ok(prompt.includes(SPEC_TEXT.trim()), "the spec text appears verbatim in the prompt");
  assert.match(prompt, /## Specification given to the fixed executor \(SPEC\.md\)/);
});

test("buildChecklistJudgePrompt instructs a dual judging standard: built behavior vs. process/plan/rollout/compatibility items", () => {
  const inv = { text: "File tree:\n- a.txt\n", truncatedFiles: [], omittedFiles: [], fileCount: 1 };
  const prompt = buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv, specText: SPEC_TEXT });

  assert.match(prompt, /dual judging standard/i);
  assert.match(prompt, /BUILT BEHAVIOR/);
  assert.match(prompt, /PROCESS, PLAN, ROLLOUT, OR COMPATIBILITY PROMISE/);
  assert.match(prompt, /explicitly and credibly commits to it/i);
  assert.match(prompt, /never hold one side to a stricter reading than the other/i);
});

test("buildChecklistJudgePrompt throws when specText is missing or empty (never silently judges without it)", () => {
  const inv = { text: "File tree:\n- a.txt\n", truncatedFiles: [], omittedFiles: [], fileCount: 1 };
  assert.throws(() => buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv }), /requires the full SPEC\.md text/);
  assert.throws(
    () => buildChecklistJudgePrompt({ acceptance: ACCEPTANCE, inventory: inv, specText: "   " }),
    /requires the full SPEC\.md text/
  );
});

// =============================================================================
// parseChecklistJudgeResponse -- defensive parsing, malformed -> ok:false
// =============================================================================

test("parseChecklistJudgeResponse: invalid JSON -> ok:false with an error note (malformed judge JSON)", () => {
  const result = parseChecklistJudgeResponse("this is not JSON at all", 3);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("parseChecklistJudgeResponse: not an object with an items array -> ok:false", () => {
  assert.strictEqual(parseChecklistJudgeResponse(JSON.stringify({ notItems: [] }), 3).ok, false);
  assert.strictEqual(parseChecklistJudgeResponse(JSON.stringify([1, 2, 3]), 3).ok, false);
});

test("parseChecklistJudgeResponse: item count mismatch against the checklist -> ok:false", () => {
  const raw = JSON.stringify({ items: [{ text: "only one", required: true, verdict: "pass" }] });
  const result = parseChecklistJudgeResponse(raw, 3);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /returned 1 item\(s\) but the checklist has 3/);
});

test("parseChecklistJudgeResponse: an item with an invalid verdict -> ok:false", () => {
  const raw = JSON.stringify({ items: [{ text: "x", required: true, verdict: "maybe" }] });
  const result = parseChecklistJudgeResponse(raw, 1);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /verdict must be one of/);
});

test("parseChecklistJudgeResponse: a well-formed response parses items with text/required/verdict", () => {
  const raw = JSON.stringify({
    items: [
      { text: "Required item one.", required: true, verdict: "pass" },
      { text: "Required item two.", required: true, verdict: "fail" },
      { text: "(Nice-to-have) optional item.", required: false, verdict: "unverifiable" },
    ],
  });
  const result = parseChecklistJudgeResponse(raw, 3);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.items.length, 3);
  assert.deepStrictEqual(result.items[1], { text: "Required item two.", required: true, verdict: "fail" });
});

test("parseChecklistJudgeResponse strips a ```json code fence, matching judge.js's tier B/C leniency", () => {
  const raw = "```json\n" + JSON.stringify({ items: [{ text: "x", required: true, verdict: "pass" }] }) + "\n```";
  const result = parseChecklistJudgeResponse(raw, 1);
  assert.strictEqual(result.ok, true);
});

// =============================================================================
// computePass -- the pre-declared pass rule
// =============================================================================

test("computePass: every required item passing -> true", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: true, verdict: "pass" },
    { text: "c", required: false, verdict: "unverifiable" },
  ];
  assert.strictEqual(computePass(items), true);
});

test("computePass: one required item failing -> false", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: true, verdict: "fail" },
  ];
  assert.strictEqual(computePass(items), false);
});

test("computePass: a required item that is unverifiable -> false (unverifiable is never a pass)", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: true, verdict: "unverifiable" },
  ];
  assert.strictEqual(computePass(items), false);
});

test("computePass: a nice-to-have item failing does NOT block an otherwise-passing result", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: false, verdict: "fail" },
    { text: "c", required: false, verdict: "unverifiable" },
  ];
  assert.strictEqual(computePass(items), true);
});

// =============================================================================
// computeRequiredPassFraction -- the graded companion metric (fixes the
// binary floor effect: two sides that both fail can differ hugely -- 9/10
// required items passing vs. 0/10 -- but computePass floors both to 0/false,
// a 0-vs-0 tie that hides the real gap).
// =============================================================================

test("computeRequiredPassFraction: fraction of REQUIRED items passing, nice-to-haves excluded from the denominator", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: true, verdict: "fail" },
    { text: "c", required: true, verdict: "pass" },
    { text: "d", required: false, verdict: "fail" }, // never enters the denominator
  ];
  assert.strictEqual(computeRequiredPassFraction(items), 2 / 3);
});

test("computeRequiredPassFraction: unverifiable counts against the fraction, same as fail", () => {
  const items = [
    { text: "a", required: true, verdict: "pass" },
    { text: "b", required: true, verdict: "unverifiable" },
  ];
  assert.strictEqual(computeRequiredPassFraction(items), 0.5);
});

test("computeRequiredPassFraction: null when items is null or not an array (mirrors pass's null-ness)", () => {
  assert.strictEqual(computeRequiredPassFraction(null), null);
  assert.strictEqual(computeRequiredPassFraction(undefined), null);
  assert.strictEqual(computeRequiredPassFraction("not an array"), null);
});

test("computeRequiredPassFraction: null (never 0 or 1) when there are zero required items", () => {
  const items = [{ text: "a", required: false, verdict: "pass" }];
  assert.strictEqual(computeRequiredPassFraction(items), null);
});

test("computeRequiredPassFraction: two sides that both binary-fail can still show very different graded fractions", () => {
  const nineOfTen = Array.from({ length: 10 }, (_, i) => ({
    text: `item ${i}`,
    required: true,
    verdict: i === 9 ? "fail" : "pass",
  }));
  const zeroOfTen = Array.from({ length: 10 }, (_, i) => ({ text: `item ${i}`, required: true, verdict: "fail" }));
  assert.strictEqual(computePass(nineOfTen), false);
  assert.strictEqual(computePass(zeroOfTen), false);
  assert.strictEqual(computeRequiredPassFraction(nineOfTen), 0.9);
  assert.strictEqual(computeRequiredPassFraction(zeroOfTen), 0);
});

// =============================================================================
// runTierDSide -- end-to-end per side, via a scripted fake executor
// =============================================================================

test("runTierDSide: no spec on any run -> pass null, reason 'no spec produced', and no executor/judge call is made", async () => {
  const scenario = makeScenario("side-no-spec");
  writeTranscript(ROOT, scenario.id, "brainstorming", 1, {}); // transcript exists, no spec named
  const exec = createFakeExec([]); // must never be called

  const result = await runTierDSide({
    scenario,
    side: "brainstorming",
    config: CONFIG,
    exec,
    root: ROOT,
    tierDRoot: TIERD_ROOT,
  });

  assert.strictEqual(result.pass, null);
  assert.strictEqual(result.reason, "no spec produced");
  assert.strictEqual(result.items, null);
  assert.strictEqual(exec.calls.length, 0);
});

test("runTierDSide: one fixed-executor call then one judge call; passes when every required item passes", async () => {
  const scenario = makeScenario("side-pass");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md", specContent: "# Spec\n" });

  const exec = createFakeExec([
    { text: "Implemented the spec.", usage: { output_tokens: 100 } },
    {
      text: JSON.stringify({
        items: [
          { text: "Required item one.", required: true, verdict: "pass" },
          { text: "Required item two.", required: true, verdict: "pass" },
          { text: "(Nice-to-have) optional item.", required: false, verdict: "fail" },
        ],
      }),
      usage: { output_tokens: 30 },
    },
  ]);

  const result = await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });

  assert.strictEqual(result.pass, true);
  assert.strictEqual(result.items.length, 3);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.specRun, 1);
  assert.strictEqual(result.frac, 1, "both required items passed -> graded fraction 1");
  assert.strictEqual(exec.calls.length, 2, "exactly one executor call and one judge call");

  // The fixed-executor call: one shot, no --resume, pinned to interviewee_model,
  // acceptEdits so it could actually write files into the sandbox.
  const buildCall = exec.calls[0];
  assert.ok(!buildCall.args.includes("--resume"));
  assert.strictEqual(buildCall.args[buildCall.args.indexOf("--model") + 1], CONFIG.interviewee_model);
  assert.ok(buildCall.args.includes("--permission-mode"));
  assert.strictEqual(buildCall.stdin, EXECUTOR_PROMPT);

  // The judge call: pinned to judge_model, never carries --permission-mode
  // (it's a stateless text-only call, matching judge.js's buildJudgeInvocation).
  const judgeCall = exec.calls[1];
  assert.strictEqual(judgeCall.args[judgeCall.args.indexOf("--model") + 1], CONFIG.judge_model);
  assert.ok(!judgeCall.args.includes("--permission-mode"));

  // The judge prompt carries the SPEC.md text the executor was given.
  assert.match(judgeCall.stdin, /## Specification given to the fixed executor \(SPEC\.md\)/);
});

// =============================================================================
// runTierDSide -- build isolation + persisted forensics (fixes 1 and 2)
// =============================================================================

test("runTierDSide: the fixed executor's cwd is OUTSIDE the data tree (runs/, runs-dry/) -- build isolation fix", async () => {
  const scenario = makeScenario("side-isolation");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    { text: "Implemented.", usage: { output_tokens: 10 } },
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
  ]);

  await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT, tmpRoot: TMP_ROOT });

  const buildCwd = exec.calls[0].cwd;
  assert.ok(buildCwd.startsWith(TMP_ROOT), "the executor's build cwd lives under the caller's tmpRoot");
  assert.ok(!buildCwd.startsWith(ROOT), "the executor's build cwd is never inside the data tree passed as root/tierDRoot");
});

test("runTierDSide: without an explicit tmpRoot, a private one is still created outside the data tree (defense in depth)", async () => {
  const scenario = makeScenario("side-isolation-default");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    { text: "Implemented.", usage: { output_tokens: 10 } },
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
  ]);

  await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });

  const buildCwd = exec.calls[0].cwd;
  assert.ok(buildCwd.startsWith(os.tmpdir()), "auto-created tmpRoot still lands under os.tmpdir()");
  assert.ok(!buildCwd.startsWith(ROOT), "auto-created tmpRoot is still never inside the data tree");
});

test("runTierDSide: persists the fixed executor's raw stdout + parsed text to build-output.json (forensics fix)", async () => {
  const scenario = makeScenario("side-build-output");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    { text: "Implemented the spec, see notes.", usage: { output_tokens: 42 }, sessionId: "sess-build-output" },
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
  ]);

  await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT, tmpRoot: TMP_ROOT });

  const outPath = path.join(TIERD_ROOT, scenario.id, "ideas", "build-output.json");
  assert.ok(fs.existsSync(outPath), "build-output.json was written under tierDRoot/<scenario>/<side>/");
  const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.strictEqual(written.text, "Implemented the spec, see notes.");
  assert.strictEqual(written.sessionId, "sess-build-output");
  assert.strictEqual(typeof written.stdout, "string", "the raw CLI stdout is persisted, not just the parsed text");
  assert.ok(JSON.parse(written.stdout).result, "the persisted stdout really is the raw CLI JSON envelope");
});

test("runTierDSide: persists a bounded artifact snapshot (the inventory already built) under tierDRoot/<scenario>/<side>/artifacts/", async () => {
  const scenario = makeScenario("side-artifacts");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    (async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, "built-file.txt"), "content the executor built");
      return { stdout: JSON.stringify({ session_id: "s1", result: "Implemented." }) };
    }),
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
  ]);

  await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT, tmpRoot: TMP_ROOT });

  const snapshotPath = path.join(TIERD_ROOT, scenario.id, "ideas", "artifacts", "inventory.txt");
  assert.ok(fs.existsSync(snapshotPath), "the artifact snapshot was written under tierDRoot/<scenario>/<side>/artifacts/");
  const snapshot = fs.readFileSync(snapshotPath, "utf8");
  assert.ok(snapshot.includes("built-file.txt"), "the snapshot carries the file tree listing");
  assert.ok(snapshot.includes("content the executor built"), "the snapshot carries the inventory text (bounded file contents)");
  assert.ok(!snapshot.includes("SPEC.md"), "SPEC.md (the input, not an artifact) is excluded, matching buildWorkspaceInventory");
});

test("runTierDSide: a required item failing -> pass false", async () => {
  const scenario = makeScenario("side-fail");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    { text: "Implemented.", usage: { output_tokens: 10 } },
    {
      text: JSON.stringify({
        items: [
          { text: "Required item one.", required: true, verdict: "pass" },
          { text: "Required item two.", required: true, verdict: "fail" },
          { text: "(Nice-to-have) optional item.", required: false, verdict: "pass" },
        ],
      }),
      usage: { output_tokens: 20 },
    },
  ]);

  const result = await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.frac, 0.5, "one of two required items passed -> graded fraction 0.5, distinct from binary false");
});

test("runTierDSide: malformed judge JSON -> pass null with an error-note reason (never a guess)", async () => {
  const scenario = makeScenario("side-malformed-judge");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([
    { text: "Implemented.", usage: { output_tokens: 10 } },
    { text: "not valid json whatsoever", usage: { output_tokens: 5 } },
  ]);

  const result = await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });
  assert.strictEqual(result.pass, null);
  assert.strictEqual(result.items, null);
  assert.strictEqual(result.frac, null);
  assert.match(result.reason, /not valid JSON/);
});

test("runTierDSide: a failing fixed-executor call -> pass null with an error-note reason, judge is never called", async () => {
  const scenario = makeScenario("side-exec-fails");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/spec.md" });

  const exec = createFakeExec([{ error: "claude CLI exited with code 1: simulated failure" }]);

  const result = await runTierDSide({ scenario, side: "ideas", config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });
  assert.strictEqual(result.pass, null);
  assert.strictEqual(result.frac, null);
  assert.match(result.reason, /fixed-executor call failed/);
  assert.strictEqual(exec.calls.length, 1, "the judge is never called once the build call fails");
  assert.ok(
    !fs.existsSync(path.join(TIERD_ROOT, scenario.id, "ideas", "build-output.json")),
    "no build-output.json is written when the executor call itself failed -- nothing to persist"
  );
});

// =============================================================================
// runTierD -- results shape matches run.js report.js's tier-d-results contract
// =============================================================================

test("runTierD returns results in the exact shape run.js's report expects: [{scenarioId, ideas_pass, brainstorming_pass, ideas_frac, brainstorming_frac}]", async () => {
  const scenarioWithSpecs = makeScenario("matrix-both");
  writeTranscript(ROOT, scenarioWithSpecs.id, "ideas", 1, { specPath: "docs/specs/a.md" });
  writeTranscript(ROOT, scenarioWithSpecs.id, "brainstorming", 1, { specPath: "docs/specs/b.md" });

  const scenarioNoSpecs = makeScenario("matrix-none");
  // no transcripts at all for either side

  const exec = createFakeExec([
    { text: "Implemented.", usage: { output_tokens: 10 } }, // matrix-both/ideas build
    {
      text: JSON.stringify({
        items: [
          { text: "Required item one.", required: true, verdict: "pass" },
          { text: "Required item two.", required: true, verdict: "pass" },
          { text: "(Nice-to-have) optional item.", required: false, verdict: "pass" },
        ],
      }),
      usage: { output_tokens: 10 },
    }, // matrix-both/ideas judge
    { text: "Implemented.", usage: { output_tokens: 10 } }, // matrix-both/brainstorming build
    {
      text: JSON.stringify({
        items: [
          { text: "Required item one.", required: true, verdict: "fail" },
          { text: "Required item two.", required: true, verdict: "pass" },
          { text: "(Nice-to-have) optional item.", required: false, verdict: "pass" },
        ],
      }),
      usage: { output_tokens: 10 },
    }, // matrix-both/brainstorming judge
  ]);

  const { results, details } = await runTierD({
    scenarios: [scenarioWithSpecs, scenarioNoSpecs],
    config: CONFIG,
    exec,
    root: ROOT,
    tierDRoot: TIERD_ROOT,
  });

  assert.strictEqual(results.length, 2);
  for (const r of results) {
    assert.strictEqual(typeof r.scenarioId, "string");
    assert.deepStrictEqual(
      Object.keys(r).sort(),
      ["brainstorming_frac", "brainstorming_pass", "ideas_frac", "ideas_pass", "scenarioId"]
    );
    assert.ok([true, false, null].includes(r.ideas_pass));
    assert.ok([true, false, null].includes(r.brainstorming_pass));
    assert.ok(r.ideas_frac === null || typeof r.ideas_frac === "number");
    assert.ok(r.brainstorming_frac === null || typeof r.brainstorming_frac === "number");
  }

  const both = results.find((r) => r.scenarioId === "matrix-both");
  assert.strictEqual(both.ideas_pass, true);
  assert.strictEqual(both.brainstorming_pass, false);
  assert.strictEqual(both.ideas_frac, 1, "both required items on the ideas side passed");
  assert.strictEqual(both.brainstorming_frac, 0.5, "one of two required items on the brainstorming side passed");

  const none = results.find((r) => r.scenarioId === "matrix-none");
  assert.strictEqual(none.ideas_pass, null);
  assert.strictEqual(none.brainstorming_pass, null);
  assert.strictEqual(none.ideas_frac, null);
  assert.strictEqual(none.brainstorming_frac, null);

  assert.strictEqual(details.length, 2, "the audit-trail file carries one entry per scenario too");
  assert.strictEqual(details[0].scenarioId, "matrix-both");
  assert.ok(details[0].ideas.items.length === 3);
  assert.strictEqual(details[1].ideas.reason, "no spec produced");
});

test("runTierD shares ONE per-invocation tmpRoot under os.tmpdir() across every scenario x side, cleaned up after the run", async () => {
  const scenario = makeScenario("matrix-shared-tmproot");
  writeTranscript(ROOT, scenario.id, "ideas", 1, { specPath: "docs/specs/a.md" });
  writeTranscript(ROOT, scenario.id, "brainstorming", 1, { specPath: "docs/specs/b.md" });

  const seenCwds = [];
  const exec = createFakeExec([
    async ({ cwd }) => {
      seenCwds.push(cwd);
      return { stdout: JSON.stringify({ session_id: "s1", result: "Implemented." }) };
    },
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
    async ({ cwd }) => {
      seenCwds.push(cwd);
      return { stdout: JSON.stringify({ session_id: "s1", result: "Implemented." }) };
    },
    { text: JSON.stringify({ items: [{ text: "Required item one.", required: true, verdict: "pass" }] }), usage: { output_tokens: 10 } },
  ]);

  await runTierD({ scenarios: [scenario], config: CONFIG, exec, root: ROOT, tierDRoot: TIERD_ROOT });

  assert.strictEqual(seenCwds.length, 2, "one build cwd per side");
  const [ideasCwd, brainstormingCwd] = seenCwds;
  assert.notStrictEqual(ideasCwd, brainstormingCwd, "each side gets its own subdirectory");
  const ideasParent = path.dirname(path.dirname(ideasCwd)); // .../<tmpRoot>/<scenarioId>/<side> -> .../<tmpRoot>
  const brainstormingParent = path.dirname(path.dirname(brainstormingCwd));
  assert.strictEqual(ideasParent, brainstormingParent, "both sides share the same per-invocation tmpRoot");
  assert.ok(!fs.existsSync(ideasParent), "the shared tmpRoot is cleaned up (best-effort) after runTierD returns");
});

// =============================================================================
// dry-run: tier-d.js writes only under runs-dry/, real runs/ is never touched
// =============================================================================

test("node tier-d.js run --dry-run: full pipeline over a real scenario writes only under runs-dry/, never runs/", async () => {
  const { main: tierDMain, RUNS_ROOT: CLI_RUNS_ROOT, RUNS_DRY_ROOT: CLI_RUNS_DRY_ROOT } = require("../tier-d.js");

  // s02-schema-migration is a real scenario (scenarios/s02-schema-migration/)
  // not used by any other test file's fixtures under runs-dry/, avoiding any
  // cross-test-file collision on the shared runs-dry/ tree.
  const scenarioId = "s02-schema-migration";
  const cliScopedRoot = CLI_RUNS_DRY_ROOT;

  // Seed exactly what run.js's `run` command would have produced for run1 on
  // both sides, so tier-d.js's dry-run executor actually exercises its build
  // + judge branches instead of hitting "no spec produced" for everything.
  writeTranscript(cliScopedRoot, scenarioId, "ideas", 1, {
    specPath: "docs/specs/spec.md",
    specContent: "# Dry-run fixture spec (ideas)\n",
  });
  writeTranscript(cliScopedRoot, scenarioId, "brainstorming", 1, {
    specPath: "docs/superpowers/specs/spec.md",
    specContent: "# Dry-run fixture spec (brainstorming)\n",
  });

  const realRunsBefore = fs.existsSync(path.join(CLI_RUNS_ROOT, scenarioId));
  const realTierDResultsBefore = fs.existsSync(path.join(CLI_RUNS_ROOT, "tier-d-results.json"));
  // Snapshot-and-compare rather than a blanket "does not exist" assertion --
  // a real bench run may have already populated runs/tier-d/ on this machine
  // (real pilot data, gitignored, never something a test should delete), so
  // hermeticity here means "the dry-run didn't change it", not "it's empty".
  const realTierDDirBefore = fs.existsSync(path.join(CLI_RUNS_ROOT, "tier-d"));

  try {
    await tierDMain(["run", "--scenario", scenarioId, "--dry-run"]);

    // Results + details land under runs-dry/, in the exact shape report.js expects.
    const results = JSON.parse(fs.readFileSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d-results.json"), "utf8"));
    const entry = results.find((r) => r.scenarioId === scenarioId);
    assert.ok(entry, "the scoped scenario has a results entry");
    assert.ok([true, false, null].includes(entry.ideas_pass));
    assert.ok([true, false, null].includes(entry.brainstorming_pass));
    assert.ok(entry.ideas_frac === null || typeof entry.ideas_frac === "number");
    assert.ok(entry.brainstorming_frac === null || typeof entry.brainstorming_frac === "number");
    assert.ok(fs.existsSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d-details.json")));

    // The dry-run sandbox itself is built OUTSIDE the data tree entirely (see
    // lib/tierd.js's buildSandbox doc comment) -- runs-dry/tier-d/ only ever
    // receives the bounded audit trail written back after the fact: the
    // build's raw output and a bounded artifact snapshot, never the sandbox
    // (and never SPEC.md, which is the input, not a built artifact).
    assert.ok(
      fs.existsSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d", scenarioId, "ideas", "build-output.json")),
      "the build's raw stdout/parsed text was persisted under runs-dry/tier-d/"
    );
    assert.ok(
      fs.existsSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d", scenarioId, "ideas", "artifacts", "inventory.txt")),
      "a bounded artifact snapshot was persisted under runs-dry/tier-d/<scenario>/<side>/artifacts/"
    );
    assert.ok(
      !fs.existsSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d", scenarioId, "ideas", "workspace")),
      "no workspace/ directory is ever created under the data tree -- the build never runs there"
    );

    // The real runs/ tree was never created or modified by this dry-run.
    assert.strictEqual(
      fs.existsSync(path.join(CLI_RUNS_ROOT, scenarioId)),
      realRunsBefore,
      "dry-run never creates anything under the real runs/<scenario>/ tree"
    );
    assert.strictEqual(
      fs.existsSync(path.join(CLI_RUNS_ROOT, "tier-d-results.json")),
      realTierDResultsBefore,
      "dry-run never writes runs/tier-d-results.json"
    );
    assert.strictEqual(
      fs.existsSync(path.join(CLI_RUNS_ROOT, "tier-d")),
      realTierDDirBefore,
      "dry-run never creates or modifies runs/tier-d/"
    );
  } finally {
    fs.rmSync(path.join(CLI_RUNS_DRY_ROOT, scenarioId), { recursive: true, force: true });
    fs.rmSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d", scenarioId), { recursive: true, force: true });
    fs.rmSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d-results.json"), { force: true });
    fs.rmSync(path.join(CLI_RUNS_DRY_ROOT, "tier-d-details.json"), { force: true });
  }
});
