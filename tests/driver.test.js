"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  runSession,
  buildSpawnPlan,
  quoteForCmd,
  buildAssistantInvocation,
  buildSimUserInvocation,
  parseClaudeOutput,
  findSpecFile,
  countQuestions,
  computeTotals,
  HARNESS_PREAMBLE,
} = require("../lib/driver");
const { buildSimUserPrompt } = require("../lib/simuser");
const { createFakeExec } = require("../fixtures/fake-cli");

const BENCH_ROOT = path.join(__dirname, "..");
const RUNS_ROOT = path.join(BENCH_ROOT, "runs");

const SCENARIO = {
  id: "test-scenario-driver",
  title: "Add a --since flag to the chlog CLI",
  domain: "CLI feature",
  hiddenDoc:
    "I run a small Node CLI called chlog. I need a --since flag. It must never make network calls " +
    "because our CI runners are air-gapped. It has to ship in Friday's minor release.",
  acceptance: "- [ ] --since flag exists\n",
  meta: {
    id: "test-scenario-driver",
    title: "Add a --since flag to the chlog CLI",
    domain: "CLI feature",
    facts: [{ id: "f1", text: "chlog is a Node CLI.", weight: "critical" }],
    ambiguities: ["Whether --until is also needed."],
    latent: ["No network calls allowed."],
  },
};

const CONFIG = {
  interviewee_model: "claude-sonnet-5",
  simuser_model: "claude-sonnet-5",
  judge_model: "claude-opus-4-8",
  runs_per_cell: 3,
  turn_cap: 25,
  workflows: {
    ideas: { kickoff: "/ideas:interview {idea}" },
    brainstorming: { kickoff: "Use the superpowers:brainstorming skill to help me flesh out this idea: {idea}" },
  },
};

let runCounter = 0;
function nextRunIndex() {
  runCounter += 1;
  return runCounter;
}

function runDirFor(workflow, runIndex) {
  return path.join(RUNS_ROOT, SCENARIO.id, workflow, `run${runIndex}`);
}

test.after(() => {
  fs.rmSync(path.join(RUNS_ROOT, SCENARIO.id), { recursive: true, force: true });
});

// --- EARS 1: loop + spec-detected + turn-cap termination -------------------

test("runSession drives kickoff -> assistant -> simuser -> assistant and ends spec-detected when a spec file appears", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "1. What should the flag be named?\n2. Any date format constraints?", usage: { output_tokens: 50 } },
    { text: "Name it --since. Accept plain dates like 2026-01-01.", usage: { output_tokens: 10 } },
    {
      text: "Here is the final spec, please approve.",
      usage: { output_tokens: 80 },
      writeSpec: "docs/specs/since-flag.md",
      specContent: "# Since flag spec\n",
    },
    { text: "looks good, approve", usage: { output_tokens: 5 } },
  ]);

  const transcript = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  assert.strictEqual(transcript.ended_by, "spec-detected");
  assert.strictEqual(transcript.artifact.spec_path, "docs/specs/since-flag.md");
  // kickoff -> assistant(1) -> simuser(1) -> assistant(2) [spec] ; simuser is
  // never called again once a spec is detected on assistant turn 2.
  assert.strictEqual(transcript.turns.length, 3);
  assert.deepStrictEqual(
    transcript.turns.map((t) => t.role),
    ["assistant", "user", "assistant"]
  );
  assert.strictEqual(exec.calls.length, 3);

  // The workspace on disk really has the spec file the driver detected.
  const workspaceDir = path.join(runDirFor("ideas", runIndex), "workspace");
  assert.ok(fs.existsSync(path.join(workspaceDir, "docs/specs/since-flag.md")));
});

test("runSession ends turn-cap when config.turn_cap is reached without a spec ever appearing", async () => {
  const runIndex = nextRunIndex();
  const smallCapConfig = { ...CONFIG, turn_cap: 2 };
  const exec = createFakeExec([
    { text: "1. What should the flag be named?", usage: { output_tokens: 20 } },
    { text: "Call it --since.", usage: { output_tokens: 8 } },
    { text: "1. Any date format constraints?", usage: { output_tokens: 20 } }, // 2nd assistant turn hits cap
  ]);

  const transcript = await runSession({
    scenario: SCENARIO,
    workflow: "ideas",
    runIndex,
    config: smallCapConfig,
    exec,
  });

  assert.strictEqual(transcript.ended_by, "turn-cap");
  assert.strictEqual(transcript.artifact.spec_path, null);
  const assistantTurns = transcript.turns.filter((t) => t.role === "assistant");
  assert.strictEqual(assistantTurns.length, 2);
  assert.strictEqual(exec.calls.length, 3);
});

// --- EARS 2: user replies always come from the injectable executor ---------

test("the user reply text is exactly what the sim-user model (via exec) returned -- never synthesized by the driver", async () => {
  const runIndex = nextRunIndex();
  const simUserReplyText = "Name it --since, plain ISO dates only, no network calls allowed.";
  const exec = createFakeExec([
    { text: "1. What should the flag be named? 2. Any date format constraints?", usage: { output_tokens: 30 } },
    { text: simUserReplyText, usage: { output_tokens: 15 } },
    { text: "1. Anything else before I finalize?", usage: { output_tokens: 10 } },
    { text: "No, that covers it.", usage: { output_tokens: 5 } },
  ]);

  const transcript = await runSession({
    scenario: SCENARIO,
    workflow: "ideas",
    runIndex,
    config: { ...CONFIG, turn_cap: 2 },
    exec,
  });

  const userTurns = transcript.turns.filter((t) => t.role === "user");
  assert.strictEqual(userTurns[0].text, simUserReplyText);

  // The sim-user call must be distinguishable as going through the same
  // executor and must be pinned to config.simuser_model, with its prompt on
  // stdin grounded in the scenario's hidden doc.
  const simUserCall = exec.calls[1];
  assert.ok(simUserCall.args.includes("--model"));
  assert.strictEqual(simUserCall.args[simUserCall.args.indexOf("--model") + 1], CONFIG.simuser_model);
  assert.ok(simUserCall.stdin.includes(SCENARIO.hiddenDoc.trim()), "sim-user prompt travels via stdin");

  // The first (kickoff) call must NOT resume a session, and every assistant
  // call must pin config.interviewee_model -- otherwise the ambient CLI
  // default model would silently decide the benchmark.
  const kickoffCall = exec.calls[0];
  assert.ok(!kickoffCall.args.includes("--resume"));
  assert.strictEqual(kickoffCall.args[kickoffCall.args.indexOf("--model") + 1], CONFIG.interviewee_model);

  // The second assistant call must resume the session returned by the first
  // and stay pinned to the interviewee model.
  const secondAssistantCall = exec.calls[2];
  assert.ok(secondAssistantCall.args.includes("--resume"));
  assert.strictEqual(secondAssistantCall.args[secondAssistantCall.args.indexOf("--resume") + 1], "fake-session-1");
  assert.strictEqual(
    secondAssistantCall.args[secondAssistantCall.args.indexOf("--model") + 1],
    CONFIG.interviewee_model
  );
});

// --- EARS 3: missing usage never fabricated ---------------------------------

test("a turn whose CLI JSON omits usage records usage null and sets totals.output_tokens_complete false", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "1. What should the flag be named?" }, // no usage key at all
    { text: "Call it --since.", usage: { output_tokens: 12 } },
    {
      text: "Final spec ready, please approve.",
      usage: { output_tokens: 40 },
      writeSpec: "docs/specs/final.md",
    },
  ]);

  const transcript = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  assert.strictEqual(transcript.turns[0].usage, null);
  assert.strictEqual(transcript.totals.output_tokens_complete, false);
  // Only the two usable turns (12 + 40) are summed -- the missing one
  // contributes nothing, never a fabricated guess.
  assert.strictEqual(transcript.totals.output_tokens, 52);
});

test("when every turn reports usage, totals.output_tokens_complete is true and sums all of them", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    {
      text: "Final spec ready, please approve.",
      usage: { output_tokens: 100 },
      writeSpec: "docs/specs/final.md",
    },
  ]);

  const transcript = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  assert.strictEqual(transcript.totals.output_tokens_complete, true);
  assert.strictEqual(transcript.totals.output_tokens, 100);
});

// --- EARS 4: fresh sandbox workspace + harness preamble ---------------------

test("a session starts in a fresh sandbox git workspace with the harness preamble prepended to the kickoff", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "Final spec ready, please approve.", usage: { output_tokens: 10 }, writeSpec: "docs/specs/final.md" },
  ]);

  await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  const workspaceDir = path.join(runDirFor("ideas", runIndex), "workspace");
  assert.ok(fs.existsSync(workspaceDir), "workspace directory was created");
  assert.ok(fs.existsSync(path.join(workspaceDir, "README.md")), "workspace has a seed README for context scan");

  const kickoffCall = exec.calls[0];
  const kickoffPrompt = kickoffCall.stdin;
  assert.ok(kickoffPrompt.startsWith(HARNESS_PREAMBLE), "harness preamble is prepended to the kickoff");
  assert.match(kickoffPrompt, /AskUserQuestion/);
  assert.match(kickoffPrompt, /numbered prose/);
  assert.ok(kickoffPrompt.includes("/ideas:interview"), "the workflow's own kickoff template is still present");
  assert.strictEqual(kickoffCall.cwd, workspaceDir, "exec runs inside the sandbox workspace, not the repo root");
});

test("every {idea} occurrence in the kickoff template is substituted, not just the first", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "Spec written.", usage: { output_tokens: 5 }, writeSpec: "docs/specs/final.md" },
  ]);
  const config = {
    ...CONFIG,
    workflows: { ...CONFIG.workflows, ideas: { kickoff: "Idea: {idea}. To restate: {idea}." } },
  };

  await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config, exec });

  const kickoffPrompt = exec.calls[0].stdin;
  assert.ok(!kickoffPrompt.includes("{idea}"), "no unsubstituted {idea} placeholder remains");
  const occurrences = kickoffPrompt.split(SCENARIO.title).length - 1;
  assert.ok(occurrences >= 2, "both placeholders were replaced with the scenario title");
});

// --- executor errors: never lose a partial run ------------------------------

test("an executor error ends the session with ended_by 'error' and still writes a partial transcript to disk", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "1. What should the flag be named?", usage: { output_tokens: 20 } },
    { text: "Call it --since.", usage: { output_tokens: 8 } },
    { error: "claude CLI exited with code 1: simulated failure" },
  ]);

  const transcript = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  assert.strictEqual(transcript.ended_by, "error");
  assert.strictEqual(transcript.turns.length, 2, "the turns completed before the failure are kept");

  const transcriptPath = path.join(runDirFor("ideas", runIndex), "transcript.json");
  assert.ok(fs.existsSync(transcriptPath), "transcript.json was written even though the session errored");
  const onDisk = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  assert.strictEqual(onDisk.ended_by, "error");
  assert.strictEqual(onDisk.turns.length, 2);
});

// --- transcript.json written to the documented path/shape ------------------

test("transcript.json is written to bench/runs/<scenario>/<workflow>/run<N>/transcript.json with the documented shape", async () => {
  const runIndex = nextRunIndex();
  const exec = createFakeExec([
    { text: "Final spec ready, please approve.", usage: { output_tokens: 10 }, writeSpec: "docs/specs/final.md" },
  ]);

  const returned = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec });

  const transcriptPath = path.join(runDirFor("ideas", runIndex), "transcript.json");
  const onDisk = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));

  for (const shape of [returned, onDisk]) {
    assert.strictEqual(shape.scenario, SCENARIO.id);
    assert.strictEqual(shape.workflow, "ideas");
    assert.strictEqual(shape.run, runIndex);
    assert.ok(Array.isArray(shape.turns));
    for (const t of shape.turns) {
      assert.ok(t.role === "assistant" || t.role === "user");
      assert.strictEqual(typeof t.text, "string");
      assert.ok(t.usage === null || typeof t.usage.output_tokens === "number");
    }
    assert.strictEqual(typeof shape.totals.output_tokens, "number");
    assert.strictEqual(typeof shape.totals.output_tokens_complete, "boolean");
    assert.strictEqual(typeof shape.totals.turns, "number");
    assert.strictEqual(typeof shape.totals.questions_asked, "number");
    assert.ok("spec_path" in shape.artifact);
    assert.ok(["spec-detected", "turn-cap", "error"].includes(shape.ended_by));
  }
});

// --- buildSimUserPrompt(scenario, transcript) -------------------------------

test("buildSimUserPrompt embeds the hidden doc, the full transcript so far, and the protocol rules", () => {
  const transcript = {
    turns: [{ role: "assistant", text: "1. What should the flag be named?", usage: null }],
  };
  const prompt = buildSimUserPrompt(SCENARIO, transcript);

  assert.ok(prompt.includes(SCENARIO.hiddenDoc.trim()), "hidden doc is embedded for grounding");
  assert.match(prompt, /ASSISTANT: 1\. What should the flag be named\?/, "prior turns are embedded");
  assert.match(prompt, /answer only what is being asked/i);
  assert.match(prompt, /planted fact/i);
  assert.match(prompt, /never volunteer/i);
  assert.match(prompt, /never rescue a wrap-up/i);
  assert.match(prompt, /concise/i);
  assert.match(prompt, /looks good, approve/i);
  assert.match(prompt, /never approve while any question.+remains unanswered/i);
});

test("buildSimUserPrompt on an empty transcript still produces a valid grounded prompt", () => {
  const prompt = buildSimUserPrompt(SCENARIO, { turns: [] });
  assert.ok(prompt.includes(SCENARIO.hiddenDoc.trim()));
  assert.match(prompt, /nothing yet/i);
});

// --- pure helper unit tests --------------------------------------------------

test("buildAssistantInvocation: no session -> kickoff form, prompt on stdin (never argv), model pinned", () => {
  const { args, stdin } = buildAssistantInvocation({
    prompt: 'multi word prompt with "quotes" & pipes | inside',
    sessionId: null,
    model: "claude-sonnet-5",
  });
  assert.deepStrictEqual(args, ["-p", "--output-format", "json", "--model", "claude-sonnet-5"]);
  assert.strictEqual(stdin, 'multi word prompt with "quotes" & pipes | inside');
  assert.ok(!args.some((a) => a.includes("multi word")), "prompt text never appears in argv");
});

test("buildAssistantInvocation: with session -> --resume form, prompt on stdin, model pinned", () => {
  const { args, stdin } = buildAssistantInvocation({
    prompt: "hello again",
    sessionId: "sess-42",
    model: "claude-sonnet-5",
  });
  assert.deepStrictEqual(args, [
    "-p",
    "--resume",
    "sess-42",
    "--output-format",
    "json",
    "--model",
    "claude-sonnet-5",
  ]);
  assert.strictEqual(stdin, "hello again");
});

test("buildSimUserInvocation pins --model and carries the prompt on stdin", () => {
  const { args, stdin } = buildSimUserInvocation({ prompt: "reply as the user", model: "claude-sonnet-5" });
  assert.deepStrictEqual(args, ["-p", "--output-format", "json", "--model", "claude-sonnet-5"]);
  assert.strictEqual(stdin, "reply as the user");
});

test("parseClaudeOutput extracts text, session_id, and usage; missing usage -> null", () => {
  const withUsage = parseClaudeOutput(JSON.stringify({ result: "hi", session_id: "s1", usage: { output_tokens: 7 } }));
  assert.deepStrictEqual(withUsage, { text: "hi", sessionId: "s1", usage: { output_tokens: 7 } });

  const withoutUsage = parseClaudeOutput(JSON.stringify({ result: "hi", session_id: "s1" }));
  assert.deepStrictEqual(withoutUsage, { text: "hi", sessionId: "s1", usage: null });
});

// Regression: a fresh Windows checkout (git autocrlf) or a CLI echoing
// Windows-authored file content can hand parseClaudeOutput a result string
// containing CRLF. This must normalize to LF identically to an LF input --
// see judge.js maskSpec, which silently no-ops its H1 title strip on
// unnormalized CRLF text (the bug this regression pins).
test("parseClaudeOutput normalizes CRLF result text to LF, matching the LF-input result exactly", () => {
  const lf = parseClaudeOutput(JSON.stringify({ result: "line one\nline two\nline three", session_id: "s1" }));
  const crlf = parseClaudeOutput(JSON.stringify({ result: "line one\r\nline two\r\nline three", session_id: "s1" }));
  assert.deepStrictEqual(crlf, lf);
  assert.ok(!crlf.text.includes("\r"), "no stray \\r survives normalization");
});

test("findSpecFile finds docs/specs/*.md and docs/superpowers/specs/*.md, skips ledgers, returns posix-relative path", () => {
  const tmp = fs.mkdtempSync(path.join(RUNS_ROOT, "..", "tmp-findspec-"));
  try {
    assert.strictEqual(findSpecFile(tmp), null, "no spec dirs yet -> null");

    fs.mkdirSync(path.join(tmp, "docs/specs"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "docs/specs/foo.ledger.md"), "ledger, not a spec");
    assert.strictEqual(findSpecFile(tmp), null, "a ledger file alone does not count");

    fs.writeFileSync(path.join(tmp, "docs/specs/foo.md"), "# spec");
    assert.strictEqual(findSpecFile(tmp), "docs/specs/foo.md");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("countQuestions counts numbered question lines only", () => {
  assert.strictEqual(countQuestions("1. What flag name?\n2. What date format?\nNot a question."), 2);
  assert.strictEqual(countQuestions("Just a statement, no questions here."), 0);
});

test("computeTotals never claims complete coverage for a zero-turn session", () => {
  const totals = computeTotals([]);
  assert.strictEqual(totals.output_tokens, 0);
  assert.strictEqual(totals.output_tokens_complete, false);
  assert.strictEqual(totals.turns, 0);
});

// --- Windows-safe spawn planning (hermetic: no live spawn) ------------------

test("quoteForCmd wraps in double quotes and doubles embedded double quotes", () => {
  assert.strictEqual(quoteForCmd("plain"), '"plain"');
  assert.strictEqual(quoteForCmd("two words"), '"two words"');
  assert.strictEqual(quoteForCmd('has "quotes" inside'), '"has ""quotes"" inside"');
  assert.strictEqual(quoteForCmd("a&b|c>d"), '"a&b|c>d"', "shell metacharacters stay inert inside quotes");
});

test("buildSpawnPlan on non-Windows spawns claude directly with args untouched", () => {
  const args = ["-p", "--output-format", "json", "--model", "claude-sonnet-5"];
  const plan = buildSpawnPlan(args, { platform: "linux" });
  assert.strictEqual(plan.command, "claude");
  assert.deepStrictEqual(plan.args, args);
  assert.deepStrictEqual(plan.options, {});
});

test("buildSpawnPlan on win32 with an .exe launcher spawns it directly, no shell", () => {
  const args = ["-p", "--output-format", "json"];
  const plan = buildSpawnPlan(args, { platform: "win32", launcher: "C:\\tools\\claude.exe" });
  assert.strictEqual(plan.command, "C:\\tools\\claude.exe");
  assert.deepStrictEqual(plan.args, args);
  assert.deepStrictEqual(plan.options, {});
});

test("buildSpawnPlan on win32 with a .cmd launcher goes through cmd.exe /d /s /c with every token quoted", () => {
  const args = ["-p", "--resume", "sess-42", "--output-format", "json", "--model", "claude-sonnet-5"];
  const plan = buildSpawnPlan(args, {
    platform: "win32",
    launcher: "C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd",
  });
  assert.ok(/cmd(\.exe)?$/i.test(plan.command), "spawns via cmd.exe");
  assert.deepStrictEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.strictEqual(plan.options.windowsVerbatimArguments, true, "Node must not re-quote the built line");

  const line = plan.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), "whole line is wrapped for /s");
  assert.ok(line.includes('"C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd"'), "space-containing launcher path is quoted");
  for (const token of args) {
    assert.ok(line.includes('"' + token + '"'), `arg token ${token} is individually quoted`);
  }
});

test("buildSpawnPlan on win32 with no resolvable launcher still routes claude.cmd through cmd.exe", () => {
  const plan = buildSpawnPlan(["-p", "--output-format", "json"], { platform: "win32", launcher: null });
  assert.ok(/cmd(\.exe)?$/i.test(plan.command));
  assert.ok(plan.args[3].includes('"claude.cmd"'));
});

// --- canonical fixture consumed by downstream (metrics) tasks --------------

test("bench/fixtures/transcript-sample.json matches the documented transcript shape and is internally consistent", () => {
  const samplePath = path.join(BENCH_ROOT, "fixtures", "transcript-sample.json");
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));

  assert.strictEqual(typeof sample.scenario, "string");
  assert.strictEqual(typeof sample.workflow, "string");
  assert.strictEqual(typeof sample.run, "number");
  assert.ok(Array.isArray(sample.turns) && sample.turns.length > 0);
  for (const t of sample.turns) {
    assert.ok(t.role === "assistant" || t.role === "user");
    assert.strictEqual(typeof t.text, "string");
    assert.ok(t.usage === null || typeof t.usage.output_tokens === "number");
  }
  assert.ok(["spec-detected", "turn-cap", "error"].includes(sample.ended_by));
  assert.ok("spec_path" in sample.artifact);

  // The fixture's totals must be exactly what computeTotals() derives from
  // its own turns -- it's meant to be a canonical, non-drifting example.
  assert.deepStrictEqual(sample.totals, computeTotals(sample.turns));
});

test("runSession rejects a non-function exec", async () => {
  await assert.rejects(
    () => runSession({ scenario: SCENARIO, workflow: "ideas", runIndex: 999, config: CONFIG, exec: null }),
    /exec must be an injectable executor/
  );
});

test("runSession rejects a config without a numeric turn_cap", async () => {
  const exec = createFakeExec([{ text: "hi", usage: { output_tokens: 1 } }]);
  await assert.rejects(
    () =>
      runSession({
        scenario: SCENARIO,
        workflow: "ideas",
        runIndex: 998,
        config: { ...CONFIG, turn_cap: undefined },
        exec,
      }),
    /turn_cap must be a number/
  );
});

// --- sandbox freshness: a re-run must never inherit a prior attempt's files ---

test("re-running at the same scenario/workflow/runIndex starts from a clean workspace, not a stale spec from a prior attempt", async () => {
  const runIndex = nextRunIndex();

  const firstExec = createFakeExec([
    {
      text: "Here's a spec from attempt one.",
      usage: { output_tokens: 10 },
      writeSpec: "docs/specs/attempt-one.md",
    },
  ]);
  const first = await runSession({ scenario: SCENARIO, workflow: "ideas", runIndex, config: CONFIG, exec: firstExec });
  assert.strictEqual(first.ended_by, "spec-detected");
  assert.strictEqual(first.artifact.spec_path, "docs/specs/attempt-one.md");

  // Second attempt at the SAME runIndex never writes a spec at all -- if the
  // workspace were not cleaned, findSpecFile would still see attempt-one.md
  // left over from the first run and falsely report spec-detected again.
  const secondExec = createFakeExec([
    { text: "1. Starting over, what should the flag be named?", usage: { output_tokens: 8 } },
  ]);
  const second = await runSession({
    scenario: SCENARIO,
    workflow: "ideas",
    runIndex,
    config: { ...CONFIG, turn_cap: 1 },
    exec: secondExec,
  });

  assert.strictEqual(second.ended_by, "turn-cap");
  assert.strictEqual(second.artifact.spec_path, null);
  const workspaceDir = path.join(runDirFor("ideas", runIndex), "workspace");
  assert.ok(!fs.existsSync(path.join(workspaceDir, "docs/specs/attempt-one.md")), "stale spec was wiped");
});
