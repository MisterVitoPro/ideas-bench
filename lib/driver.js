"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const { buildSimUserPrompt } = require("./simuser");

const BENCH_RUNS_ROOT = path.join(__dirname, "..", "runs");

// Prepended to every kickoff prompt. Headless runs cannot answer
// AskUserQuestion (see the plan header's flagged constraints), so both
// workflows under test are told, identically, to ask in numbered prose.
const HARNESS_PREAMBLE = [
  "You are running headlessly inside an automated benchmark harness.",
  "AskUserQuestion and any other interactive question tool are unavailable in this session.",
  'Ask every question you need answered as plain numbered prose in your reply text (e.g. "1. ...", "2. ...") and wait for the numbered answers in the next message.',
  "Work only inside this sandbox workspace directory -- do not read or write anything outside it.",
].join("\n");

const SPEC_DIRS = ["docs/specs", "docs/superpowers/specs"];

// --- pure helpers (exported for direct unit testing) -----------------------

function isLedgerFile(filename) {
  return /\.ledger\.md$/i.test(filename);
}

// findSpecFile(workspaceDir) -> relative posix path string | null
//
// Looks for a non-ledger *.md file directly under docs/specs/ or
// docs/superpowers/specs/ inside the sandbox workspace. Single-level glob,
// deterministic (alphabetical) pick when more than one exists.
function findSpecFile(workspaceDir) {
  for (const rel of SPEC_DIRS) {
    const dir = path.join(workspaceDir, rel);
    if (!fs.existsSync(dir)) continue;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !isLedgerFile(e.name))
      .map((e) => e.name)
      .sort();
    if (entries.length > 0) {
      return path.posix.join(rel, entries[0]);
    }
  }
  return null;
}

// countQuestions(text) -> number of numbered-question lines ("1. ...?")
function countQuestions(text) {
  if (typeof text !== "string") return 0;
  const matches = text.match(/^\s*\d+[.)]\s+.+\?\s*$/gm);
  return matches ? matches.length : 0;
}

// The prompt is deliberately NOT placed in argv: it travels via stdin
// (`claude -p` reads the prompt from stdin when no positional prompt is
// given). This sidesteps Windows cmd.exe quoting entirely -- prompt text can
// contain quotes, &, |, newlines, and be arbitrarily long -- and keeps argv
// down to fixed, shell-safe tokens (flags, session ids, model names).

// buildAssistantInvocation({prompt, sessionId, model}) -> {args, stdin}
//
// First turn:       claude -p --output-format json --model <m>   (prompt on stdin)
// Subsequent turns: claude -p --resume <session_id> --output-format json --model <m>
//
// The assistant/interviewee is pinned to config.interviewee_model on every
// turn -- without the pin, the ambient CLI default model would silently
// decide the benchmark.
function buildAssistantInvocation({ prompt, sessionId, model }) {
  const args = sessionId
    ? ["-p", "--resume", sessionId, "--output-format", "json", "--model", model]
    : ["-p", "--output-format", "json", "--model", model];
  return { args, stdin: prompt };
}

// buildSimUserInvocation({prompt, model}) -> {args, stdin}
//
// The sim-user is a separate, stateless claude -p call pinned to
// config.simuser_model -- no --resume, no session continuity.
function buildSimUserInvocation({ prompt, model }) {
  return { args: ["-p", "--output-format", "json", "--model", model], stdin: prompt };
}

// parseClaudeOutput(stdout) -> {text, sessionId, usage}
//
// usage is null (never fabricated) whenever the CLI JSON omits it or the
// output_tokens field isn't a number.
function parseClaudeOutput(stdout) {
  const parsed = JSON.parse(stdout);
  const rawText =
    typeof parsed.result === "string"
      ? parsed.result
      : typeof parsed.text === "string"
        ? parsed.text
        : "";
  // Ingestion seam: the CLI's JSON result text can carry CRLF (e.g. content
  // echoing a Windows-checked-out file). Normalize here, once, so every
  // downstream consumer of turn text (countQuestions, the judge prompts,
  // maskSpec via the spec file it echoes) sees LF consistently.
  const text = rawText.replace(/\r\n/g, "\n");
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
  if (text === "" || sessionId === null) {
    // Degradation path: the CLI JSON is parseable but missing expected
    // fields (result/text empty, or no session_id). Warn loudly so
    // real-CLI schema drift is diagnosable instead of silently producing
    // empty turns / un-resumable sessions.
    console.warn(
      "bench driver: claude CLI JSON missing expected fields " +
        `(text ${text === "" ? "empty" : "ok"}, session_id ${sessionId === null ? "missing" : "ok"}) -- possible schema drift`
    );
  }
  const outputTokens =
    parsed.usage && typeof parsed.usage.output_tokens === "number" ? parsed.usage.output_tokens : null;
  return { text, sessionId, usage: outputTokens === null ? null : { output_tokens: outputTokens } };
}

// computeTotals(turns) -> {output_tokens, output_tokens_complete, turns, questions_asked}
//
// Best-effort token accounting: sums only usable (non-null) per-turn
// usage, never fabricates a count for a missing one. output_tokens_complete
// is true only when every turn in the session reported usage, and is false
// (not vacuously true) for a zero-turn session -- there is no coverage to
// claim when nothing ran.
function computeTotals(turns) {
  const usages = turns.map((t) =>
    t.usage && typeof t.usage.output_tokens === "number" ? t.usage.output_tokens : null
  );
  const outputTokens = usages.reduce((sum, v) => sum + (v === null ? 0 : v), 0);
  const complete = turns.length > 0 && usages.every((v) => v !== null);
  const questionsAsked = turns
    .filter((t) => t.role === "assistant")
    .reduce((sum, t) => sum + countQuestions(t.text), 0);
  return {
    output_tokens: outputTokens,
    output_tokens_complete: complete,
    turns: turns.length,
    questions_asked: questionsAsked,
  };
}

function buildKickoffPrompt(workflow, scenario, config) {
  const workflowCfg = config && config.workflows && config.workflows[workflow];
  if (!workflowCfg || typeof workflowCfg.kickoff !== "string") {
    throw new Error(`driver: no kickoff template configured for workflow "${workflow}"`);
  }
  const kickoffText = workflowCfg.kickoff.replaceAll("{idea}", scenario.title);
  return `${HARNESS_PREAMBLE}\n\n${kickoffText}`;
}

// tryGitInit(cwd) -> boolean (best-effort; never throws)
//
// git is optional tooling for the sandbox, not a hard dependency of the
// harness -- if it's unavailable or init fails for any reason, the run
// still proceeds without a workspace repo.
function tryGitInit(cwd) {
  try {
    execSync("git --version", { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execSync("git init", { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureSandbox(scenario, workflow, runIndex) {
  const runDir = path.join(BENCH_RUNS_ROOT, scenario.id, workflow, `run${runIndex}`);
  const workspaceDir = path.join(runDir, "workspace");
  // Always start from a clean workspace: a re-run at the same run-index must
  // never inherit a leftover file (e.g. a stray spec) from a prior attempt,
  // which could otherwise short-circuit spec detection falsely.
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "README.md"),
    `# ${scenario.title}\n\nSandbox workspace for a bench harness run. Nothing outside this directory is in scope.\n`
  );
  tryGitInit(workspaceDir);
  return { runDir, workspaceDir };
}

async function callAssistant(exec, { prompt, sessionId, model }, cwd) {
  const { args, stdin } = buildAssistantInvocation({ prompt, sessionId, model });
  const { stdout } = await exec({ args, stdin, cwd });
  return parseClaudeOutput(stdout);
}

async function callSimUser(exec, { prompt, model }, cwd) {
  const { args, stdin } = buildSimUserInvocation({ prompt, model });
  const { stdout } = await exec({ args, stdin, cwd });
  return parseClaudeOutput(stdout);
}

// --- the real executor (never used by tests -- see fixtures/fake-cli.js) ---

// quoteForCmd(arg) -> string
//
// Quotes one argument for a cmd.exe /s /c command line: wrap in double
// quotes and double any embedded double quotes. Only ever applied to the
// fixed flag/id/model tokens in argv (the prompt travels via stdin and
// never passes through cmd.exe), but implemented properly anyway so a
// session id or model name containing unexpected characters cannot break
// tokenization or be interpreted by the shell.
function quoteForCmd(arg) {
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

// resolveClaudeLauncher() -> absolute path string | null
//
// Scans PATH for the claude launcher (claude.exe / claude.cmd / claude.bat,
// in that preference order per directory) instead of relying on shell:true
// PATH resolution.
function resolveClaudeLauncher() {
  const exts = [".exe", ".cmd", ".bat"];
  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, "claude" + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // unreadable PATH entry -- skip it
      }
    }
  }
  return null;
}

// buildSpawnPlan(args, opts) -> {command, args, options}
//
// Decides how to spawn the claude CLI without shell:true (which joins argv
// with no per-argument quoting and lets cmd.exe interpret &, |, quotes...).
//   - non-Windows: spawn `claude` directly with args untouched.
//   - Windows, launcher is an .exe: spawn it directly (no shell involved).
//   - Windows, launcher is a .cmd/.bat (the npm default) or unresolved:
//     .cmd files can only run through cmd.exe, so spawn
//     `cmd.exe /d /s /c "<launcher> <args...>"` with every token quoted via
//     quoteForCmd and windowsVerbatimArguments so Node does not re-mangle
//     the line we built.
// `opts` ({platform, launcher}) exists for hermetic unit testing only.
function buildSpawnPlan(args, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32") {
    return { command: "claude", args, options: {} };
  }

  const launcher =
    opts.launcher !== undefined ? opts.launcher : resolveClaudeLauncher();

  if (launcher && launcher.toLowerCase().endsWith(".exe")) {
    return { command: launcher, args, options: {} };
  }

  const commandLine = [launcher || "claude.cmd", ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", '"' + commandLine + '"'],
    options: { windowsVerbatimArguments: true },
  };
}

// claudeCliExec({args, stdin, cwd}) -> Promise<{stdout}>
//
// Spawns the claude CLI headlessly per buildSpawnPlan and writes the prompt
// to the child's stdin (`claude -p` reads the prompt from stdin when no
// positional prompt argument is given).
function claudeCliExec({ args, stdin, cwd }) {
  return new Promise((resolve, reject) => {
    const plan = buildSpawnPlan(args);
    const child = spawn(plan.command, plan.args, {
      cwd,
      windowsHide: true,
      ...plan.options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout });
    });
    child.stdin.on("error", () => {
      // If the child exits before consuming stdin, the write EPIPEs; the
      // close handler above already reports the real failure.
    });
    child.stdin.end(typeof stdin === "string" ? stdin : "");
  });
}

// runSession({scenario, workflow, runIndex, config, exec}) -> Promise<transcript>
//
// Drives kickoff -> assistant -> simuser -> assistant -> ... until either a
// spec file is detected in the sandbox workspace, the assistant-turn cap is
// reached, or the executor throws. Always writes transcript.json (a
// partial, error-terminated run is still a written run -- never lost).
async function runSession({ scenario, workflow, runIndex, config, exec }) {
  if (typeof exec !== "function") {
    throw new TypeError("runSession: exec must be an injectable executor function");
  }
  if (!config || typeof config.turn_cap !== "number") {
    throw new TypeError("runSession: config.turn_cap must be a number");
  }

  const { runDir, workspaceDir } = ensureSandbox(scenario, workflow, runIndex);

  const transcript = {
    scenario: scenario.id,
    workflow,
    run: runIndex,
    turns: [],
  };

  let endedBy = null;
  let specPath = null;
  let sessionId = null;
  let prompt = buildKickoffPrompt(workflow, scenario, config);

  try {
    for (;;) {
      const assistantOut = await callAssistant(
        exec,
        { prompt, sessionId, model: config.interviewee_model },
        workspaceDir
      );
      transcript.turns.push({ role: "assistant", text: assistantOut.text, usage: assistantOut.usage });
      if (assistantOut.sessionId) sessionId = assistantOut.sessionId;

      const found = findSpecFile(workspaceDir);
      if (found) {
        endedBy = "spec-detected";
        specPath = found;
        break;
      }

      const assistantTurnCount = transcript.turns.filter((t) => t.role === "assistant").length;
      if (assistantTurnCount >= config.turn_cap) {
        endedBy = "turn-cap";
        break;
      }

      const simUserPrompt = buildSimUserPrompt(scenario, transcript);
      const simOut = await callSimUser(exec, { prompt: simUserPrompt, model: config.simuser_model }, workspaceDir);
      transcript.turns.push({ role: "user", text: simOut.text, usage: simOut.usage });

      prompt = simOut.text;
    }
  } catch (err) {
    endedBy = "error";
    transcript.error = err.message;
  }

  transcript.totals = computeTotals(transcript.turns);
  transcript.artifact = { spec_path: specPath };
  transcript.ended_by = endedBy;

  fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2) + "\n");

  return transcript;
}

module.exports = {
  runSession,
  claudeCliExec,
  resolveClaudeLauncher,
  buildSpawnPlan,
  quoteForCmd,
  buildAssistantInvocation,
  buildSimUserInvocation,
  parseClaudeOutput,
  findSpecFile,
  countQuestions,
  computeTotals,
  HARNESS_PREAMBLE,
};
