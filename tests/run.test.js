"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  parseArgs,
  usage,
  main,
  RUNS_ROOT,
  RUNS_DRY_ROOT,
  parsePluginListJSON,
  parsePluginListText,
  findPluginVersion,
  DryRunContaminationError,
  checkForDryRunContamination,
} = require("../run.js");

const BENCH_ROOT = path.join(__dirname, "..");
// Every main() call in this file passes --dry-run, so all pipeline writes
// land under RUNS_DRY_ROOT (runs-dry/), never under the real RUNS_ROOT
// (runs/) -- see the "dry-run pipeline writes only under runs-dry/" test
// below. RUNS_ROOT is imported only so tests can assert real/ was left
// untouched, and for the dry-run-contamination fixture (which deliberately
// writes a throwaway fixture scenario under the real root, then removes it).
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
  // Every main() call in this file passes --dry-run, so cleanup targets
  // RUNS_DRY_ROOT exclusively -- this must never touch RUNS_ROOT (runs/),
  // which can hold real, non-dry run data (see the dry-run-segregation
  // tests below for why that distinction matters).
  fs.rmSync(path.join(RUNS_DRY_ROOT, SCENARIO_ID), { recursive: true, force: true });
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

  const tierCPath = path.join(RUNS_DRY_ROOT, SCENARIO_ID, "run1", "tierC.json");
  assert.ok(fs.existsSync(tierCPath), "tierC.json was written for run1 once both workflows were scored");
  const tierC = JSON.parse(fs.readFileSync(tierCPath, "utf8"));
  assert.strictEqual(tierC.scenario, SCENARIO_ID);
  assert.strictEqual(typeof tierC.dimensions, "object");
});

// =============================================================================
// FIX 1 (shakedown bug): --dry-run drives run/score/report through a
// completely separate runs-dry/ root, end to end -- driver sandbox/
// transcript paths, score inputs/outputs, and report input+output. Before
// this fix, --dry-run wrote into the same runs/ tree real runs use, so a
// later real `report` could silently aggregate stale dry-run scenarios
// alongside real ones (the exact failure this repo's first live shakedown
// hit: 1 real scenario aggregated with 5 stale dry-run scenarios).
// =============================================================================

// walk(dir) -> string[] of every file path under dir, recursively (empty
// array if dir doesn't exist).
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("the full dry-run pipeline (run, score, report) writes only under runs-dry/, and leaves runs/ byte-for-byte untouched", async () => {
  const before = new Set(walk(RUNS_ROOT));

  await main(["run", "--scenario", SCENARIO_ID, "--dry-run"]);
  await main(["score", "--scenario", SCENARIO_ID, "--dry-run"]);
  await main(["report", "--scenario", SCENARIO_ID, "--dry-run"]);

  const after = new Set(walk(RUNS_ROOT));
  assert.deepStrictEqual(after, before, "the real runs/ tree must be byte-for-byte unchanged by a dry-run pipeline run");

  assert.ok(
    fs.existsSync(path.join(RUNS_DRY_ROOT, SCENARIO_ID, "ideas", "run1", "transcript.json")),
    "dry-run driver output lives under runs-dry/"
  );
  assert.ok(
    fs.existsSync(path.join(RUNS_DRY_ROOT, SCENARIO_ID, "ideas", "run1", "metrics.json")),
    "dry-run score output lives under runs-dry/"
  );
  assert.ok(fs.existsSync(path.join(RUNS_DRY_ROOT, "report.md")), "dry-run report output lives under runs-dry/");

  const transcript = JSON.parse(
    fs.readFileSync(path.join(RUNS_DRY_ROOT, SCENARIO_ID, "ideas", "run1", "transcript.json"), "utf8")
  );
  assert.strictEqual(transcript.dry_run, true, "dry-run transcripts are marked dry_run:true");

  const dryReport = fs.readFileSync(path.join(RUNS_DRY_ROOT, "report.md"), "utf8");
  assert.match(dryReport, /scenario\(s\) scored/);
});

// =============================================================================
// FIX 1, belt-and-braces: real-mode report refuses with a named error if it
// finds a transcript marked dry_run:true under the real runs/ tree.
// =============================================================================

test("checkForDryRunContamination throws the named DryRunContaminationError for a fixture transcript marked dry_run:true", () => {
  const fixtureScenarioId = "s03-ui-component"; // real scenario id, no real run data on disk for it
  const fixtureDir = path.join(RUNS_ROOT, fixtureScenarioId, "brainstorming", "run1");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "transcript.json"), JSON.stringify({ dry_run: true }));

  try {
    assert.throws(
      () =>
        checkForDryRunContamination({
          scenarios: [{ id: fixtureScenarioId }],
          config: { runs_per_cell: 1 },
        }),
      (err) => {
        assert.ok(err instanceof DryRunContaminationError);
        assert.strictEqual(err.name, "DryRunContaminationError");
        assert.match(err.message, /dry_run:true/);
        assert.match(err.message, /runs-dry/);
        return true;
      }
    );
  } finally {
    fs.rmSync(path.join(RUNS_ROOT, fixtureScenarioId), { recursive: true, force: true });
  }
});

test("checkForDryRunContamination does not throw for a scenario with no transcript, or a transcript that is not dry-run", () => {
  const fixtureScenarioId = "s04-auth-flow"; // real scenario id, no real run data on disk for it
  assert.doesNotThrow(() =>
    checkForDryRunContamination({ scenarios: [{ id: fixtureScenarioId }], config: { runs_per_cell: 1 } })
  );

  const fixtureDir = path.join(RUNS_ROOT, fixtureScenarioId, "ideas", "run1");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "transcript.json"), JSON.stringify({ dry_run: false }));
  try {
    assert.doesNotThrow(() =>
      checkForDryRunContamination({ scenarios: [{ id: fixtureScenarioId }], config: { runs_per_cell: 1 } })
    );
  } finally {
    fs.rmSync(path.join(RUNS_ROOT, fixtureScenarioId), { recursive: true, force: true });
  }
});

test("real-mode `report` (no --dry-run) refuses with DryRunContaminationError end to end on a fixture tree containing a dry_run:true transcript", async () => {
  const fixtureScenarioId = "s05-data-pipeline"; // real scenario id, no real run data on disk for it
  const fixtureDir = path.join(RUNS_ROOT, fixtureScenarioId, "ideas", "run1");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "transcript.json"),
    JSON.stringify({
      scenario: fixtureScenarioId,
      workflow: "ideas",
      run: 1,
      dry_run: true,
      turns: [],
      totals: { output_tokens: 0, output_tokens_complete: false, turns: 0, questions_asked: 0 },
      artifact: { spec_path: null },
      ended_by: "turn-cap",
      retries: 0,
    })
  );

  try {
    await assert.rejects(
      () => main(["report", "--scenario", fixtureScenarioId]),
      (err) => {
        assert.strictEqual(err.name, "DryRunContaminationError");
        return true;
      }
    );
  } finally {
    fs.rmSync(path.join(RUNS_ROOT, fixtureScenarioId), { recursive: true, force: true });
  }
});

// =============================================================================
// FIX 3: getPinnedVersions' `claude plugin list` parsing. `--json` entries
// carry an "id" field shaped "<name>@<marketplace>" -- there is no separate
// "name" field (the previous bug: matching on p.name never matched
// anything). Hermetic against captured real sample output (see
// fixtures/plugin-list-sample.json / .txt); the live probe itself
// (probeInstalledPlugins, which spawns the real claude CLI) is deliberately
// left untested.
// =============================================================================

test("parsePluginListJSON derives name from id (no separate name field) and normalizes 'unknown' versions to null, against captured real sample output", () => {
  const sample = fs.readFileSync(path.join(BENCH_ROOT, "fixtures", "plugin-list-sample.json"), "utf8");
  const entries = parsePluginListJSON(sample);

  assert.ok(Array.isArray(entries));
  const ideas = entries.find((e) => e.name === "ideas");
  assert.strictEqual(ideas.version, "0.2.1");
  const superpowers = entries.find((e) => e.name === "superpowers");
  assert.strictEqual(superpowers.version, "6.1.1");

  // "commit-commands" reports the literal string "unknown" in the real CLI
  // output -- that must come back as null, never the word "unknown" treated
  // as if it were a real version.
  const commitCommands = entries.find((e) => e.name === "commit-commands");
  assert.strictEqual(commitCommands.version, null);
});

test("parsePluginListJSON returns null (never throws) on unparseable or non-array input", () => {
  assert.strictEqual(parsePluginListJSON("not json"), null);
  assert.strictEqual(parsePluginListJSON(JSON.stringify({ not: "an array" })), null);
});

test("parsePluginListText parses the plain-text `claude plugin list` fallback form against captured real sample output", () => {
  const sample = fs.readFileSync(path.join(BENCH_ROOT, "fixtures", "plugin-list-sample.txt"), "utf8");
  const entries = parsePluginListText(sample);

  const ideas = entries.find((e) => e.name === "ideas");
  assert.strictEqual(ideas.version, "0.2.1");
  const superpowers = entries.find((e) => e.name === "superpowers");
  assert.strictEqual(superpowers.version, "6.1.1");
  const commitCommands = entries.find((e) => e.name === "commit-commands");
  assert.strictEqual(commitCommands.version, null, "'unknown' is normalized to null in the text form too");
});

test("findPluginVersion finds the first matching entry by short name and returns null when absent", () => {
  const entries = [
    { id: "ideas@mp", name: "ideas", version: "0.2.1" },
    { id: "superpowers@mp", name: "superpowers", version: "6.1.1" },
  ];
  assert.strictEqual(findPluginVersion(entries, "superpowers"), "6.1.1");
  assert.strictEqual(findPluginVersion(entries, "nonexistent-plugin"), null);
  assert.strictEqual(findPluginVersion(null, "ideas"), null, "never throws on a null entries list (probe failure)");
});
