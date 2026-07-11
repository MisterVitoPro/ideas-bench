#!/usr/bin/env node
"use strict";

// tier-d.js -- automated tier D CLI: node tier-d.js run [--scenario <id>] [--dry-run]
//
// Drives lib/tierd.js's runTierD over every scenario in scope: for each
// scenario x side (ideas, brainstorming), select a spec from an already-`run`
// transcript (see run.js's `run` command), build it in a fresh sandbox with
// the fixed executor (config.interviewee_model, one call, no access to the
// scenario's hidden-doc.md), then judge the built workspace against the
// scenario's held-out acceptance checklist (config.judge_model). Writes
// runs/tier-d-results.json (the summary run.js's `report` command already
// knows how to render) and runs/tier-d-details.json (full per-item audit
// trail). `--dry-run` routes everything through an in-process scripted fake
// executor and writes under runs-dry/ instead -- zero network, exit 0.

const fs = require("node:fs");
const path = require("node:path");

const { loadScenarios } = require("./lib/scenarios");
const { claudeCliExec } = require("./lib/driver");
const { runTierD, EXECUTOR_PROMPT, CHECKLIST_JUDGE_MARKER } = require("./lib/tierd");

const BENCH_ROOT = __dirname;
const RUNS_ROOT = path.join(BENCH_ROOT, "runs");
// --dry-run segregation matches run.js exactly: dry-run reads and writes a
// completely separate runs-dry/ tree, end to end, so dry-run and real tier D
// artifacts can never share a directory (see run.js's RUNS_DRY_ROOT doc
// comment for the same rationale, repeated here rather than imported so this
// file has no runtime dependency on run.js).
const RUNS_DRY_ROOT = path.join(BENCH_ROOT, "runs-dry");
const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");
const CONFIG_PATH = path.join(BENCH_ROOT, "config.json");

function runsRootFor(dryRun) {
  return dryRun ? RUNS_DRY_ROOT : RUNS_ROOT;
}

function tierDRootFor(dryRun) {
  return path.join(runsRootFor(dryRun), "tier-d");
}

// --- CLI argument parsing ----------------------------------------------------

const COMMANDS = ["run"];

// parseArgs(argv) -> {command, scenario, dryRun}
//
// Throws a plain Error (never a stack-trace dump) on any unrecognized
// command/flag/value so main() can print a one-line usage message and exit
// non-zero -- CLI misuse should never look like a benchmark failure.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    throw new Error(`unknown command "${command}" -- expected one of: ${COMMANDS.join(", ")}`);
  }
  const opts = { command, scenario: null, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scenario") {
      opts.scenario = rest[++i];
      if (!opts.scenario) throw new Error("--scenario requires a value");
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
    "usage: node tier-d.js run [--scenario <id>] [--dry-run]",
    "",
    "  run   for each scenario x side (ideas, brainstorming): build the spec each side",
    "        already produced (see run.js's `run` command) with a fixed executor, then",
    "        judge the result against the scenario's held-out acceptance checklist.",
    "        Writes runs/tier-d-results.json (summary) and runs/tier-d-details.json (audit).",
  ].join("\n");
}

// --- dry-run executor: scripted, in-process, zero network -------------------
//
// Distinguishes a checklist-judge call from a fixed-executor call by
// inspecting the prompt for CHECKLIST_JUDGE_MARKER, the same technique
// run.js's own dry-run executor uses for its judge prompts (FACT_JUDGE_MARKER
// / DIMENSION_JUDGE_MARKER) -- never by call order, since this needs to
// generically complete an arbitrary scenario x side matrix.
function cliJson(result, usage) {
  const payload = { session_id: "tier-d-dry-run-session", result };
  if (usage !== undefined) payload.usage = usage;
  return { stdout: JSON.stringify(payload) };
}

// extractChecklistItemTexts(prompt) -> string[]
//
// The checklist-judge prompt embeds the scenario's acceptance.md checklist
// verbatim (see lib/tierd.js's buildChecklistJudgePrompt), so the item
// count varies per real scenario (e.g. 12 for s01-cli-flag). A fixed-count
// canned response would fail lib/tierd.js's own item-count cross-check
// (parseChecklistJudgeResponse) against whatever real checklist is in
// scope -- so, like run.js's dry-run exec extracting fact ids via
// FACT_LINE_RE, this extracts the real "- [ ] ..." bullet lines out of the
// prompt instead of guessing a count.
const CHECKLIST_ITEM_LINE_RE = /^-\s*\[ \]\s*(.+)$/gm;
function extractChecklistItemTexts(prompt) {
  const texts = [];
  let m;
  CHECKLIST_ITEM_LINE_RE.lastIndex = 0;
  while ((m = CHECKLIST_ITEM_LINE_RE.exec(prompt))) texts.push(m[1].trim());
  return texts;
}

function makeDryRunExec() {
  return async function dryRunExec({ stdin, cwd }) {
    const prompt = typeof stdin === "string" ? stdin : "";

    if (prompt.includes(CHECKLIST_JUDGE_MARKER)) {
      const itemTexts = extractChecklistItemTexts(prompt);
      const verdicts = ["pass", "fail", "unverifiable"];
      const items = itemTexts.map((text, i) => ({
        text,
        required: !text.includes("(Nice-to-have)"),
        verdict: verdicts[i % verdicts.length],
      }));
      return cliJson(JSON.stringify({ items }), { output_tokens: 20 });
    }

    if (prompt.includes(EXECUTOR_PROMPT)) {
      fs.writeFileSync(
        path.join(cwd, "IMPLEMENTATION-NOTES.md"),
        "# Implementation notes\n\nDry-run placeholder build generated by tier-d.js --dry-run.\n"
      );
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "src", "index.js"),
        "// dry-run placeholder implementation -- see IMPLEMENTATION-NOTES.md\nmodule.exports = {};\n"
      );
      return cliJson("Implemented the spec. See IMPLEMENTATION-NOTES.md for assumptions.", { output_tokens: 60 });
    }

    throw new Error("tier-d.js dry-run exec: prompt matched neither the checklist-judge nor the executor marker");
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

// --- commands -----------------------------------------------------------------

async function cmdRun({ config, opts }) {
  const scenarios = selectScenarios(opts.scenario);
  const exec = opts.dryRun ? makeDryRunExec() : claudeCliExec;
  const root = runsRootFor(opts.dryRun);
  const tierDRoot = tierDRootFor(opts.dryRun);

  const { results, details } = await runTierD({ scenarios, config, exec, root, tierDRoot });

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "tier-d-results.json"), JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "tier-d-details.json"), JSON.stringify(details, null, 2) + "\n");

  for (const r of results) {
    console.log(`[tier-d] ${r.scenarioId}: ideas_pass=${r.ideas_pass} brainstorming_pass=${r.brainstorming_pass}`);
  }
  console.log(
    `[tier-d] complete: ${results.length} scenario(s) evaluated${opts.dryRun ? " (dry-run, zero network)" : ""}.`
  );
}

// --- entrypoint -----------------------------------------------------------

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`tier-d.js: ${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const config = readConfig();
  if (opts.command === "run") await cmdRun({ config, opts });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`tier-d.js: fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  usage,
  makeDryRunExec,
  main,
  RUNS_ROOT,
  RUNS_DRY_ROOT,
};
