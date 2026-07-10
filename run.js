#!/usr/bin/env node
"use strict";

// bench/run.js -- orchestrator CLI: node bench/run.js <run|score|report> [--scenario id] [--workflow ideas|brainstorming] [--dry-run]
//
//   run    -- drives config.runs_per_cell sessions per scenario x workflow cell
//             (bench/lib/driver.js runSession), writing transcript.json per run.
//   score  -- computes tier A (deterministic), tier B (one judge call per
//             scenario/workflow/run), and tier C (one masked, order-swapped
//             judge comparison per scenario/run, paired across workflows)
//             over already-run transcripts, writing metrics.json / tierC.json.
//   report -- aggregates every metrics.json + tierC.json under bench/runs/,
//             runs the paired statistics (bench/lib/report.js), and writes
//             bench/runs/report.md.
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
const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");
const CONFIG_PATH = path.join(BENCH_ROOT, "config.json");
const TIER_D_RESULTS_PATH = path.join(RUNS_ROOT, "tier-d-results.json");

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
    "usage: node bench/run.js <run|score|report> [--scenario <id>] [--workflow <ideas|brainstorming>] [--dry-run]",
    "",
    "  run     drive config.runs_per_cell sessions per scenario x workflow cell",
    "  score   compute tier A/B/C metrics over already-run transcripts",
    "  report  aggregate all metrics into bench/runs/report.md",
  ].join("\n");
}

// --- dry-run executor: scripted, in-process, zero network -------------------
//
// A single generic executor stands in for the real claude CLI across every
// exec() call the pipeline makes -- assistant turns, sim-user turns, and
// both judge call shapes (tier B fact-matching, tier C dimension-scoring).
// It tells these apart by inspecting the prompt text for the same fixed
// strings each real prompt builder emits (see judge.js/simuser.js), never by
// call order -- unlike bench/fixtures/fake-cli.js's strictly-scripted
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
          "One-line summary: placeholder spec generated by bench/run.js --dry-run for pipeline validation.\n\n" +
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

function runDir(scenarioId, workflow, runIndex) {
  return path.join(RUNS_ROOT, scenarioId, workflow, `run${runIndex}`);
}

function transcriptPath(scenarioId, workflow, runIndex) {
  return path.join(runDir(scenarioId, workflow, runIndex), "transcript.json");
}

function metricsPath(scenarioId, workflow, runIndex) {
  return path.join(runDir(scenarioId, workflow, runIndex), "metrics.json");
}

function tierCPath(scenarioId, runIndex) {
  return path.join(RUNS_ROOT, scenarioId, `run${runIndex}`, "tierC.json");
}

function readJSONIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readSpecText(transcript) {
  const specPath = transcript && transcript.artifact && transcript.artifact.spec_path;
  if (!specPath) return null;
  const workspaceDir = path.join(path.dirname(transcriptPath(transcript.scenario, transcript.workflow, transcript.run)), "workspace");
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

  let count = 0;
  for (const scenario of scenarios) {
    for (const workflow of workflows) {
      for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
        const transcript = await runSession({ scenario, workflow, runIndex, config, exec });
        count += 1;
        console.log(`[run] ${scenario.id}/${workflow}/run${runIndex}: ended_by=${transcript.ended_by}`);
      }
    }
  }
  console.log(`[run] complete: ${count} session(s) driven${opts.dryRun ? " (dry-run, zero network)" : ""}.`);
}

async function scoreOneRun({ scenario, workflow, runIndex, config, exec }) {
  const tPath = transcriptPath(scenario.id, workflow, runIndex);
  const transcript = readJSONIfExists(tPath);
  if (!transcript) {
    console.log(`[score] ${scenario.id}/${workflow}/run${runIndex}: no transcript.json -- skipped (run it first)`);
    return null;
  }

  const a = computeTierA(transcript);
  const spec = readSpecText(transcript);
  const b = await computeTierB({ scenario, transcript, spec, exec, model: config.judge_model });

  const metrics = { scenario: scenario.id, workflow, run: runIndex, tierA: a, tierB: b, spec_present: spec !== null };
  fs.writeFileSync(metricsPath(scenario.id, workflow, runIndex), JSON.stringify(metrics, null, 2) + "\n");
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
        const result = await scoreOneRun({ scenario, workflow, runIndex, config, exec });
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
      fs.mkdirSync(path.dirname(tierCPath(scenario.id, runIndex)), { recursive: true });
      fs.writeFileSync(tierCPath(scenario.id, runIndex), JSON.stringify({ scenario: scenario.id, run: runIndex, dimensions }, null, 2) + "\n");
      console.log(`[score] ${scenario.id}/run${runIndex}: tier C scored (5 dimensions, masked + order-swapped)`);
    }
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

  let superpowers = null;
  try {
    const out = execSync("claude plugin list --json", { encoding: "utf8", timeout: 10000 });
    const list = JSON.parse(out);
    const found = Array.isArray(list) ? list.find((p) => p && p.name === "superpowers") : null;
    superpowers = found && found.version ? found.version : null;
  } catch {
    superpowers = null;
  }

  return { ideas, superpowers, claude_cli };
}

function loadTierDResults() {
  const results = readJSONIfExists(TIER_D_RESULTS_PATH);
  return Array.isArray(results) ? results : null;
}

async function cmdReport({ config, opts }) {
  if (opts.workflow) {
    console.log(
      `[report] note: --workflow is ignored by the report command -- report always aggregates both workflows' ` +
        `metrics (it is a paired comparison by construction). Use --workflow with run/score to scope those steps.`
    );
  }

  const scenarios = selectScenarios(opts.scenario);

  const reportScenarios = scenarios.map((scenario) => {
    const runs = [];
    for (let runIndex = 1; runIndex <= config.runs_per_cell; runIndex++) {
      const ideasMetrics = readJSONIfExists(metricsPath(scenario.id, "ideas", runIndex));
      const brainstormingMetrics = readJSONIfExists(metricsPath(scenario.id, "brainstorming", runIndex));
      const tierCFile = readJSONIfExists(tierCPath(scenario.id, runIndex));
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

  const tierD = loadTierDResults();
  const versions = getPinnedVersions({ dryRun: opts.dryRun });

  const markdown = buildReport({ scenarios: reportScenarios, tierD, config, versions });
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const outPath = path.join(RUNS_ROOT, "report.md");
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
    console.error(`bench/run.js: ${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const config = readConfig();
  fs.mkdirSync(RUNS_ROOT, { recursive: true });

  if (opts.command === "run") await cmdRun({ config, opts });
  else if (opts.command === "score") await cmdScore({ config, opts });
  else if (opts.command === "report") await cmdReport({ config, opts });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`bench/run.js: fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  usage,
  makeDryRunExec,
  extractFactIds,
  getPinnedVersions,
  main,
};
