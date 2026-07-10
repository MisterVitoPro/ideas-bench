"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { parseArgs, usage, main } = require("../run.js");

const BENCH_ROOT = path.join(__dirname, "..");
const RUNS_ROOT = path.join(BENCH_ROOT, "runs");
const SCENARIO_ID = "s01-cli-flag";

// captureLogs(fn) -> Promise<string[]>
//
// Runs fn() (which may call console.log any number of times) with
// console.log replaced by a capturing stub, always restoring the real
// console.log afterward even if fn() rejects.
async function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test.after(() => {
  fs.rmSync(path.join(RUNS_ROOT, SCENARIO_ID), { recursive: true, force: true });
});

// =============================================================================
// parseArgs / usage: unchanged CLI surface -- smoke coverage since run.js has
// no prior dedicated test file.
// =============================================================================

test("parseArgs accepts a bare command and defaults scenario/workflow/dryRun", () => {
  assert.deepStrictEqual(parseArgs(["run"]), { command: "run", scenario: null, workflow: null, dryRun: false });
});

test("parseArgs rejects an unknown command without a stack-trace-shaped message", () => {
  assert.throws(() => parseArgs(["bogus"]), /unknown command "bogus"/);
});

test("usage() names all three subcommands", () => {
  const text = usage();
  assert.match(text, /\brun\b/);
  assert.match(text, /\bscore\b/);
  assert.match(text, /\breport\b/);
});

// =============================================================================
// MINOR 7: `report --workflow X` warns that --workflow is ignored, instead of
// silently accepting a flag report never reads.
// =============================================================================

test("cmdReport logs a one-line warning that --workflow is ignored by report", async () => {
  const logs = await captureLogs(() => main(["report", "--workflow", "ideas", "--scenario", SCENARIO_ID, "--dry-run"]));
  assert.ok(
    logs.some((l) => l.includes("--workflow is ignored by the report command")),
    "expected a warning naming --workflow as ignored; got:\n" + logs.join("\n")
  );
});

test("cmdReport logs no --workflow warning when --workflow was not passed", async () => {
  const logs = await captureLogs(() => main(["report", "--scenario", SCENARIO_ID, "--dry-run"]));
  assert.ok(!logs.some((l) => l.includes("--workflow is ignored")));
});

// =============================================================================
// MINOR 4: cmdScore names the condition when tier C is silently skipped
// because only one workflow is in scope of the invocation (not because the
// transcripts are missing).
// =============================================================================

test("cmdScore logs the tier-C-skip reason by name when only one workflow is in scope", async () => {
  await main(["run", "--scenario", SCENARIO_ID, "--workflow", "ideas", "--dry-run"]);

  const logs = await captureLogs(() => main(["score", "--scenario", SCENARIO_ID, "--workflow", "ideas", "--dry-run"]));
  assert.ok(
    logs.some((l) => l.includes("tier C skipped -- both workflows must be in scope of the same score invocation")),
    "expected the named tier-C-skip condition; got:\n" + logs.join("\n")
  );
});

// =============================================================================
// MINOR 5: cmdScore's specsByWorkflow is derived from config.workflows, not
// hardcoded to exactly "ideas"/"brainstorming" -- regression coverage that
// the derived pairing still produces a tierC.json when both real configured
// workflows are in scope.
// =============================================================================

test("cmdScore still pairs and scores tier C for both configured workflows end to end (specsByWorkflow derived from config.workflows)", async () => {
  await main(["run", "--scenario", SCENARIO_ID, "--dry-run"]);
  await main(["score", "--scenario", SCENARIO_ID, "--dry-run"]);

  const tierCPath = path.join(RUNS_ROOT, SCENARIO_ID, "run1", "tierC.json");
  assert.ok(fs.existsSync(tierCPath), "tierC.json was written for run1 once both workflows were scored");
  const tierC = JSON.parse(fs.readFileSync(tierCPath, "utf8"));
  assert.strictEqual(tierC.scenario, SCENARIO_ID);
  assert.strictEqual(typeof tierC.dimensions, "object");
});
