#!/usr/bin/env node
"use strict";

// run.js -- orchestrator CLI: node run.js <run|score|report> [--scenario id] [--workflow ideas|brainstorming] [--dry-run]
//
//   run    -- drives config.runs_per_cell sessions per scenario x workflow cell
//             (lib/driver.js runSession), writing transcript.json per run.
//   score  -- computes tier A (deterministic), tier B (one judge call per
//             scenario/workflow/run), and tier C (one masked, order-swapped
//             judge comparison per scenario/run, paired across workflows)
//             over already-run transcripts, writing metrics.json / tierC.json.
//   report -- aggregates every metrics.json + tierC.json under runs/,
//             runs the paired statistics (lib/report.js), and writes
//             runs/report.md.
//
// --dry-run drives every subcommand through a scripted, in-process fake
// executor (see makeDryRunExec below) instead of the real claude CLI: zero
// network calls, deterministic output, safe to run in any environment.

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const { loadScenarios } = require("./lib/scenarios");
const { runSession, claudeCliExec } = require("./lib/driver");
const { tierA: computeTierA, tierB: computeTierB, tierC: computeTierC } = require("./lib/metrics");
const { buildReport } = require("./lib/report");

const BENCH_ROOT = __dirname;
const REPO_ROOT = path.join(BENCH_ROOT, "..");
const RUNS_ROOT = path.join(BENCH_ROOT, "runs");
// --dry-run drives run/score/report through this completely separate root,
// end to end (driver sandbox/transcript paths, score inputs/outputs, report
// input+output) -- dry-run and real artifacts must never share a directory
// tree, so a later real `report` can never silently aggregate stale
// dry-run scenarios alongside real ones (see checkForDryRunContamination
// below for the belt-and-braces check on top of this segregation).
const RUNS_DRY_ROOT = path.join(BENCH_ROOT, "runs-dry");
const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");
const CONFIG_PATH = path.join(BENCH_ROOT, "config.json");

// runsRootFor(dryRun) -> RUNS_DRY_ROOT | RUNS_ROOT
function runsRootFor(dryRun) {
  return dryRun ? RUNS_DRY_ROOT : RUNS_ROOT;
}

function tierDResultsPath(root) {
  return path.join(root, "tier-d-results.json");
}

// DryRunContaminationError -- named error type for the belt-and-braces
// check in cmdReport: real-mode report refuses to run if it finds a
// transcript under runs/ marked dry_run:true. Never thrown for the reverse
// (a real transcript found under runs-dry/) -- that's harmless and ignored.
class DryRunContaminationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DryRunContaminationError";
  }
}

const COMMANDS = ["run", "score", "report"];
const WORKFLOWS = ["ideas", "brainstorming"];

// --- CLI argument parsing ----------------------------------------------------

// parseArgs(argv) -> {command, scenario, workflow, dryRun}
//
// Throws a plain Error (never a stack-trace dump) on any unrecognized
// command/flag/value so `main()` can print a one-line usage message and
// exit non-zero -- CLI misuse should never look like a benchmark failure.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    throw new Error(`unknown command "${command}" -- expected one of: ${COMMANDS.join(", ")}`);
  }
  const opts = { command, scenario: null, workflow: null, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scenario") {
      opts.scenario = rest[++i];
      if (!opts.scenario) throw new Error("--scenario requires a value");
    } else if (arg === "--workflow") {
      opts.workflow = rest[++i];
      if (!WORKFLOWS.includes(opts.workflow)) {
        throw new Error(`--workflow must be one of: ${WORKFLOWS.join(", ")}, got "${opts.workflow}"`);
      }
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

function usage() {
  return [
    "usage: node run.js <run|score|report> [--scenario <id>] [--workflow <ideas|brainstorming>] [--dry-run]",
    "",
    "  run     drive config.runs_per_cell sessions per scenario x workflow cell",
    "  score   compute tier A/B/C metrics over already-run transcripts",
    "  report  aggregate all metrics into runs/report.md",
  ].join("\n");
}

// --- dry-run executor: scripted, in-process, zero network -------------------
//
// A single generic executor stands in for the real claude CLI across every
// exec() call the pipeline makes -- assistant turns, sim-user turns, and
// both judge call shapes (tier B fact-matching, tier C dimension-scoring).
// It tells these apart by inspecting the prompt text for the same fixed
// strings each real prompt builder emits (see judge.js/simuser.js), never by
// call order -- unlike fixtures/fake-cli.js's strictly-scripted
// createFakeExec (built for exact per-call test assertions), this needs to
// generically complete an arbitrary number of sessions across the full
// scenario x workflow x run matrix.
const SIM_USER_MARKER = "You are role-playing as the human user";
const FACT_JUDGE_MARKER = '"active" | "passive" | "missed"';
const DIMENSION_JUDGE_MARKER = "<integer 1-5>";
const FACT_LINE_RE = /^- (\S+) \[(?:critical|nice)\]:/gm;

function extractFactIds(prompt) {
  const ids = [];
  let m;
  FACT_LINE_RE.lastIndex = 0;
  while ((m = FACT_LINE_RE.exec(prompt))) ids.push(m[1]);
  return ids;
}

function cliJson(result, usage) {
  const payload = { session_id: "dry-run-session", result };
  if (usage !== undefined) payload.usage = usage;
  return { stdout: JSON.stringify(payload) };
}

// makeDryRunExec() -> exec function (same {args, stdin, cwd} -> Promise<{stdout}> contract)
function makeDryRunExec() {
  const assistantTurns = new Map(); // workspace cwd -> assistant-turn count

  return async function dryRunExec({ stdin, cwd }) {
    const prompt = typeof stdin === "string" ? stdin : "";

    if (prompt.includes(FACT_JUDGE_MARKER)) {
      const ids = extractFactIds(prompt);
      const elicited = ["active", "passive", "missed"];
      const facts = Object.fromEntries(ids.map((id, i) => [id, elicited[i % elicited.length]]));
      return cliJson(
        JSON.stringify({ facts, silent_assumptions: [], flagged_assumptions: ["dry-run: placeholder assumption"] }),
        { output_tokens: 15 }
      );
    }

    if (prompt.includes(DIMENSION_JUDGE_MARKER)) {
      return cliJson(JSON.stringify({ document_1: 4, document_2: 3 }), { output_tokens: 8 });
    }

    if (prompt.includes(SIM_USER_MARKER)) {
      return cliJson("Sure -- here's what I can tell you about that.", { output_tokens: 12 });
    }

    // Otherwise: an assistant/interviewee turn. Write a spec on the second
    // assistant turn in this workspace so runSession() terminates
    // spec-detected, deterministically, for every scenario x workflow cell.
    const turnCount = (assistantTurns.get(cwd) || 0) + 1;
    assistantTurns.set(cwd, turnCount);

    if (turnCount >= 2) {
      const specDir = path.join(cwd, "docs", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(
        path.join(specDir, "dry-run-spec.md"),
        "# Dry-run spec\n\n" +
          "One-line summary: placeholder spec generated by run.js --dry-run for pipeline validation.\n\n" +
          "## Requirements\n\n- Placeholder requirement generated in dry-run mode.\n\n" +
          "## Assumptions\n\n- None -- this is a dry-run fixture, not a real interview output.\n"
      );
      return cliJson("Here's the spec, written to docs/specs/dry-run-spec.md. Let me know if that looks right.", {
        output_tokens: 40,
      });
    }

    return cliJson("1. What is the most important constraint here?\n2. Any other requirements?", {
      output_tokens: 20,
    });
  };
}

// --- shared helpers -----------------------------------------------------------

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function selectScenarios(scenarioFilter) {
  const all = loadScenarios(SCENARIOS_DIR);
  if (!scenarioFilter) return all;
  const found = all.find((s) => s.id === scenarioFilter);
  if (!found) {
    throw new Error(`--scenario "${scenarioFilter}" not found -- known scenarios: ${all.map((s) => s.id).join(", ")}`);
  }
  return [found];
}

function selectWorkflows(config, workflowFilter) {
  const all = Object.keys(config.workflows || {});
  if (!workflowFilter) return all;
  if (!all.includes(workflowFilter)) {
    throw new Error(`--workflow "${workflowFilter}" has no kickoff template in config.json`);
  }
  return [workflowFilter];
}

// Every path helper below takes `root` explicitly (RUNS_ROOT or
// RUNS_DRY_ROOT, per runsRootFor(opts.dryRun)) rather than closing over a
// single module-level constant -- this is what makes dry-run segregation
// end to end possible: every command threads the same root through its
// reads and writes.
function runDir(root, scenarioId, workflow, runIndex) {
  return path.join(root, scenarioId, workflow, `run${runIndex}`);
}

function transcriptPath(root, scenarioId, workflow, runIndex) {
  return path.join(runDir(root, scenarioId, workflow, runIndex), "transcript.json");
}

function metricsPath(root, scenarioId, workflow, runIndex) {
  return path.join(runDir(root, scenarioId, workflow, runIndex), "metrics.json");
}

function tierCPath(root, scenarioId, runIndex) {
  return path.join(root, scenarioId, `run${runIndex}`, "tierC.json");
}

function readJSONIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readSpecText(root, transcript) {
  const specPath = transcript && transcript.artifact && transcript.artifact.spec_path;
  if (!specPath) return null;
  const workspaceDir = path.join(
    path.dirname(transcriptPath(root, transcript.scenario, transcript.workflow, transcript.run)),
    "workspace"
  );
  try {
    // Ingestion seam: the produced spec is a file written inside the sandbox
    // workspace, so on Windows it may carry CRLF -- normalize here so both
    // tier B (raw spec text in the fact-judge prompt) and tier C (maskSpec)
    // consistently receive LF, matching the CLI-output seam in driver.js.
    return fs.readFileSync(path.join(workspaceDir, specPath), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

// --- commands -----------------------------------------------------------------

async function cmdRun({ config, opts }) {
  const scenarios = selectScenarios(opts.scenario);
  const workflows = selectWorkflows(config, opts.workflow);
  const exec = opts.dryRun ? makeDryRunExec() : claudeCliExec;
  const root = runsRootFor(opts.dryRun);

  let count = 0;
  for (const scenario of scenarios) {
    for (const workflow of workflows) {
      for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
        const transcript = await runSession({
          scenario,
          workflow,
          runIndex,
          config,
          exec,
          runsRoot: root,
          dryRun: opts.dryRun,
        });
        count += 1;
        console.log(`[run] ${scenario.id}/${workflow}/run${runIndex}: ended_by=${transcript.ended_by}`);
      }
    }
  }
  console.log(`[run] complete: ${count} session(s) driven${opts.dryRun ? " (dry-run, zero network)" : ""}.`);
}

async function scoreOneRun({ scenario, workflow, runIndex, config, exec, root }) {
  const tPath = transcriptPath(root, scenario.id, workflow, runIndex);
  const transcript = readJSONIfExists(tPath);
  if (!transcript) {
    console.log(`[score] ${scenario.id}/${workflow}/run${runIndex}: no transcript.json -- skipped (run it first)`);
    return null;
  }

  const a = computeTierA(transcript);
  const spec = readSpecText(root, transcript);
  const b = await computeTierB({ scenario, transcript, spec, exec, model: config.judge_model });

  const metrics = { scenario: scenario.id, workflow, run: runIndex, tierA: a, tierB: b, spec_present: spec !== null };
  fs.writeFileSync(metricsPath(root, scenario.id, workflow, runIndex), JSON.stringify(metrics, null, 2) + "\n");
  console.log(
    `[score] ${scenario.id}/${workflow}/run${runIndex}: tierA.output_tokens=${a.output_tokens} tierB.active_pct=${
      b.active_pct === null ? "null" : b.active_pct.toFixed(2)
    }`
  );
  return { transcript, spec };
}

async function cmdScore({ config, opts }) {
  const scenarios = selectScenarios(opts.scenario);
  const workflows = selectWorkflows(config, opts.workflow);
  const exec = opts.dryRun ? makeDryRunExec() : claudeCliExec;
  const root = runsRootFor(opts.dryRun);

  // Derived from config.workflows rather than hardcoded, so specsByWorkflow
  // always has a slot for every workflow the config actually declares.
  const allWorkflows = Object.keys(config.workflows || {});

  for (const scenario of scenarios) {
    // Tier B (per scenario/workflow/run) can run for whatever workflow subset
    // was requested; tier C (paired across workflows) only runs when BOTH
    // sides are in scope and both actually produced a spec for that run.
    const specsByWorkflow = Object.fromEntries(
      allWorkflows.map((w) => [w, new Array(config.runs_per_cell).fill(null)])
    );

    for (const workflow of workflows) {
      for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
        const result = await scoreOneRun({ scenario, workflow, runIndex, config, exec, root });
        if (result) specsByWorkflow[workflow][runIndex - 1] = result.spec;
      }
    }

    const bothWorkflowsInScope = workflows.includes("ideas") && workflows.includes("brainstorming");
    if (!bothWorkflowsInScope) {
      console.log(
        `[score] ${scenario.id}: tier C skipped -- both workflows must be in scope of the same score invocation ` +
          `(got: ${workflows.join(", ") || "none"})`
      );
      continue;
    }

    for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
      const specA = specsByWorkflow.ideas[runIndex - 1];
      const specB = specsByWorkflow.brainstorming[runIndex - 1];
      if (!specA || !specB) {
        console.log(`[score] ${scenario.id}/run${runIndex}: tier C skipped -- missing a spec on one or both sides`);
        continue;
      }
      const dimensions = await computeTierC({ specA, specB, exec, model: config.judge_model });
      fs.mkdirSync(path.dirname(tierCPath(root, scenario.id, runIndex)), { recursive: true });
      fs.writeFileSync(
        tierCPath(root, scenario.id, runIndex),
        JSON.stringify({ scenario: scenario.id, run: runIndex, dimensions }, null, 2) + "\n"
      );
      console.log(`[score] ${scenario.id}/run${runIndex}: tier C scored (5 dimensions, masked + order-swapped)`);
    }
  }
}

// --- claude plugin list parsing ---------------------------------------------
//
// `claude plugin list --json` returns a JSON array of entries shaped like:
//   { "id": "<name>@<marketplace>", "version": "1.2.3" | "unknown", "scope": ..., "enabled": ..., ... }
// There is NO separate `name` field -- the plugin's short name is the part
// of `id` before the first "@". (Confirmed against a real installed-plugin
// list: `claude plugin list --json` on this machine, which has both `ideas`
// and `superpowers` installed, returns exactly this shape.) The previous
// version of this probe looked for `p.name === "superpowers"`, which never
// matched anything -- every entry's `name` field is undefined -- so the
// pinned version came back null even with a real install present.
//
// parsePluginListJSON(jsonText) -> Array<{id, name, version}> | null
//
// Pure, hermetic, unit-tested against captured sample output (see
// tests/run.test.js). Returns null (never throws) on unparseable/non-array
// input so callers can fall back or record null, never a guess. A version
// of the literal string "unknown" (the CLI's own placeholder for plugins
// with no resolvable version) is normalized to null here too -- reporting
// the word "unknown" as if it were a version string would be dishonest.
function parsePluginListJSON(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((p) => p && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      name: p.id.split("@")[0],
      version: typeof p.version === "string" && p.version !== "unknown" ? p.version : null,
    }));
}

// parsePluginListText(text) -> Array<{id, name, version}>
//
// Fallback parser for the plain-text `claude plugin list` form, used only
// when the --json form is unavailable or fails to parse. Entries look like:
//   "  ❯ <name>@<marketplace>\n    Version: <version>\n    Scope: ...\n    Status: ..."
// (the marker is the U+276F "heavy right-pointing angle quotation mark
// ornament" character, "❯"). Matched leniently on any non-whitespace
// bullet-like prefix followed by "name@marketplace" so a marker glyph swap
// across CLI versions doesn't silently break this fallback.
const PLUGIN_LIST_TEXT_ENTRY_RE = /^\s*\S+\s+(\S+@\S+)\s*$\n\s*Version:\s*(\S+)/gm;
function parsePluginListText(text) {
  const entries = [];
  if (typeof text !== "string") return entries;
  let m;
  PLUGIN_LIST_TEXT_ENTRY_RE.lastIndex = 0;
  while ((m = PLUGIN_LIST_TEXT_ENTRY_RE.exec(text))) {
    const id = m[1];
    const version = m[2];
    entries.push({
      id,
      name: id.split("@")[0],
      version: version && version !== "unknown" ? version : null,
    });
  }
  return entries;
}

// findPluginVersion(entries, name) -> string | null
function findPluginVersion(entries, name) {
  if (!Array.isArray(entries)) return null;
  const found = entries.find((e) => e.name === name);
  return found ? found.version : null;
}

// probeInstalledPlugins() -> Array<{id, name, version}> | null
//
// Prefers `claude plugin list --json`; falls back to parsing the plain-text
// `claude plugin list` form if the JSON form fails (spawn error, non-zero
// exit, unparseable output). Never throws -- returns null when both fail.
// This is the only function in this module that spawns the live claude CLI
// for a plugin-list probe; it is deliberately left untested (see the doc
// comment on getPinnedVersions) since it depends on the real, installed CLI
// -- parsePluginListJSON/parsePluginListText carry the hermetic test
// coverage for the parsing logic itself.
function probeInstalledPlugins() {
  try {
    const out = execSync("claude plugin list --json", { encoding: "utf8", timeout: 10000 });
    const parsed = parsePluginListJSON(out);
    if (parsed !== null) return parsed;
  } catch {
    // fall through to the text-mode probe below
  }
  try {
    const out = execSync("claude plugin list", { encoding: "utf8", timeout: 10000 });
    return parsePluginListText(out);
  } catch {
    return null;
  }
}

// getPinnedVersions({config, dryRun}) -> {ideas, superpowers, claude_cli}
//
// Best-effort, per the repo's honesty invariants: every field is null (never
// fabricated) when it cannot be determined. Skipped entirely in --dry-run so
// dry-run never spawns the claude CLI itself for a `--version`/`plugin list`
// probe -- dry-run spawns no model calls and no claude CLI process at all
// (see makeDryRunExec above). This is narrower than "zero process spawn"
// overall: git init still runs per sandbox workspace on every run, dry-run
// included (see driver.js's tryGitInit), best-effort and never a hard
// dependency.
//
// `ideas`'s version is read from a local .claude-plugin/plugin.json first
// (a monorepo-adjacent-checkout convenience, kept for back-compat) and only
// falls back to the live plugin-list probe when that file isn't found --
// e.g. this repo now lives standalone (see the "Extract bench to standalone
// ideas-bench repo" commit), so REPO_ROOT/.claude-plugin/plugin.json no
// longer resolves on a typical checkout, and the probe is what actually
// finds it.
function getPinnedVersions({ dryRun }) {
  let ideas = null;
  try {
    ideas = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    ideas = null;
  }

  if (dryRun) {
    return { ideas, superpowers: null, claude_cli: null };
  }

  let claude_cli = null;
  try {
    claude_cli = execSync("claude --version", { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    claude_cli = null;
  }

  const pluginEntries = probeInstalledPlugins();
  if (ideas === null) ideas = findPluginVersion(pluginEntries, "ideas");
  const superpowers = findPluginVersion(pluginEntries, "superpowers");

  return { ideas, superpowers, claude_cli };
}

function loadTierDResults(root) {
  const results = readJSONIfExists(tierDResultsPath(root));
  return Array.isArray(results) ? results : null;
}

// checkForDryRunContamination({scenarios, config}) -> void (throws DryRunContaminationError)
//
// Belt-and-braces safety net on top of the runs/ vs runs-dry/ root
// segregation: real-mode report must never silently aggregate a dry-run
// transcript that somehow ended up under the real runs/ tree (a stray
// hand-copied fixture, a bug in an older build of this tool, etc). Scans
// every transcript.json in scope of this report invocation (same
// scenario/workflow/run traversal report itself uses) and throws the
// moment it finds one marked dry_run:true. Always scans RUNS_ROOT
// specifically -- this check only ever runs in real mode (see cmdReport),
// and the reverse case (a real transcript found under runs-dry/) is never
// checked here: harmless, and dry-run mode never calls this at all.
function checkForDryRunContamination({ scenarios, config }) {
  for (const scenario of scenarios) {
    for (const workflow of WORKFLOWS) {
      for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
        const tPath = transcriptPath(RUNS_ROOT, scenario.id, workflow, runIndex);
        const transcript = readJSONIfExists(tPath);
        if (transcript && transcript.dry_run === true) {
          throw new DryRunContaminationError(
            `dry-run contamination: "${tPath}" is marked dry_run:true but lives under the real runs/ tree -- ` +
              `refusing to aggregate it into a real report. Dry-run artifacts belong under runs-dry/ ` +
              `(run "node run.js run --dry-run" writes there, not under runs/).`
          );
        }
      }
    }
  }
}

async function cmdReport({ config, opts }) {
  if (opts.workflow) {
    console.log(
      `[report] note: --workflow is ignored by the report command -- report always aggregates both workflows' ` +
        `metrics (it is a paired comparison by construction). Use --workflow with run/score to scope those steps.`
    );
  }

  const root = runsRootFor(opts.dryRun);
  const scenarios = selectScenarios(opts.scenario);

  const reportScenarios = scenarios.map((scenario) => {
    const runs = [];
    for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
      const ideasMetrics = readJSONIfExists(metricsPath(root, scenario.id, "ideas", runIndex));
      const brainstormingMetrics = readJSONIfExists(metricsPath(root, scenario.id, "brainstorming", runIndex));
      const tierCFile = readJSONIfExists(tierCPath(root, scenario.id, runIndex));
      runs.push({
        ideas: { tierA: ideasMetrics ? ideasMetrics.tierA : null, tierB: ideasMetrics ? ideasMetrics.tierB : null },
        brainstorming: {
          tierA: brainstormingMetrics ? brainstormingMetrics.tierA : null,
          tierB: brainstormingMetrics ? brainstormingMetrics.tierB : null,
        },
        tierC: tierCFile ? tierCFile.dimensions : null,
      });
    }
    return { id: scenario.id, title: scenario.title, meta: scenario.meta, runs };
  });

  // Real mode only -- dry-run mode never touches RUNS_ROOT at all, so there
  // is nothing to check (see the doc comment on checkForDryRunContamination).
  // Runs before any live CLI probe (getPinnedVersions) so a contamination
  // hit fails fast without ever spawning the claude CLI.
  if (!opts.dryRun) {
    checkForDryRunContamination({ scenarios, config });
  }

  const tierD = loadTierDResults(root);
  const versions = getPinnedVersions({ dryRun: opts.dryRun });

  const markdown = buildReport({ scenarios: reportScenarios, tierD, config, versions });
  fs.mkdirSync(root, { recursive: true });
  const outPath = path.join(root, "report.md");
  fs.writeFileSync(outPath, markdown);
  console.log(`[report] wrote ${outPath}`);
  const verdictLine = markdown.split("\n").find((l) => l.startsWith("**Verdict:"));
  if (verdictLine) console.log(`[report] ${verdictLine.replace(/\*\*/g, "")}`);
}

// --- entrypoint -----------------------------------------------------------

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`run.js: ${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const config = readConfig();
  fs.mkdirSync(runsRootFor(opts.dryRun), { recursive: true });

  if (opts.command === "run") await cmdRun({ config, opts });
  else if (opts.command === "score") await cmdScore({ config, opts });
  else if (opts.command === "report") await cmdReport({ config, opts });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`run.js: fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  usage,
  makeDryRunExec,
  extractFactIds,
  getPinnedVersions,
  parsePluginListJSON,
  parsePluginListText,
  findPluginVersion,
  DryRunContaminationError,
  checkForDryRunContamination,
  RUNS_ROOT,
  RUNS_DRY_ROOT,
  main,
};
