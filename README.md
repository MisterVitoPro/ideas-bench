# ideas-bench

The paired, blind, simulated-user benchmark comparing `/ideas:interview` against
`superpowers:brainstorming`, per the ideas plugin's design spec measurement section
([docs/specs/2026-07-08-ideas-design.md, section 13](https://github.com/MisterVitoPro/ideas/blob/v0.3.1/docs/specs/2026-07-08-ideas-design.md)).
By MisterVitoPro.

This harness lives in its own repo so the [ideas plugin](https://github.com/MisterVitoPro/ideas)
ships lean -- installers pull none of this tooling. `runs/` (all generated run
output: transcripts, per-run metrics, `report.md`) is gitignored -- never commit it.
`--dry-run` never touches `runs/`: it writes the identical tree shape under a
separate `runs-dry/` root instead (also gitignored), end to end -- driver
sandbox/transcript paths, score inputs/outputs, and report input+output. This
keeps dry-run/test artifacts from ever contaminating a real `report` (a real
`report` also refuses, with a named error, if it ever finds a transcript
under `runs/` marked `dry_run:true`).

## Prerequisites

- `ideas` installed (this repo) and `superpowers` installed, at the versions you want
  compared. Pin both intentionally before a real (non-`--dry-run`) run -- the harness
  records whatever is installed at run time (see "Pinned versions" below), it does not
  choose or upgrade anything for you.
- The `claude` CLI on `PATH`, authenticated, with access to every model named in
  `config.json` (`interviewee_model`, `simuser_model`, `judge_model`).
- Node.js (no npm dependencies -- this harness is plain CommonJS).

## Run matrix

For each of the 6 shipped scenarios (`scenarios/s01-s06`, see `scenarios/SCHEMA.md`)
x each of the 2 workflows (`ideas`, `brainstorming`) x `config.runs_per_cell` (3) runs =
**36 sessions** for a full pass at the current pilot scale. The design spec's target is
N = 15-20 scenarios; shipping with 6 is a deliberate pilot (see Caveats below and the
plan header's flagged constraints) -- `report.md` labels any run with fewer than 15
*scored* scenarios (scenarios with actual data, not just corpus size) **PILOT**, never
silently presenting pilot numbers as the real thing. The header states both counts, e.g.
"1 of 6 scenario(s) scored" when only 1 of the 6-scenario corpus has been run/scored.

## CLI

```
node run.js <run|score|report> [--scenario <id>] [--workflow <ideas|brainstorming>] [--dry-run]
```

- **`run`** -- drives `config.runs_per_cell` sessions per scenario x workflow cell
  (`lib/driver.js`'s `runSession`), writing `runs/<scenario>/<workflow>/run<N>/transcript.json`.
- **`score`** -- computes tier A (deterministic, no model calls), tier B (one judge call
  per scenario/workflow/run), and tier C (one masked, order-swapped judge comparison per
  scenario/run -- **paired** across both workflows' specs for that run index, so it only
  runs when both workflows are in scope of the same `score` invocation, i.e. `--workflow`
  was not used to filter to a single side for that invocation) over already-`run`
  transcripts. Writes `metrics.json` next to each transcript, and
  `runs/<scenario>/run<N>/tierC.json`. When only one workflow is in scope, `score`
  logs the skip and names the condition rather than silently omitting tier C.
- **`report`** -- aggregates every `metrics.json` + `tierC.json` under `runs/`, runs
  the paired statistics (`lib/report.js`), and writes `runs/report.md`. `report`
  always aggregates both workflows (it is a paired comparison by construction); passing
  `--workflow` to it logs a one-line warning that the flag is ignored.

`--scenario <id>` and `--workflow <ideas|brainstorming>` filter the `run`/`score`
subcommands to one scenario and/or one workflow (`report` ignores `--workflow`, see above).
`--dry-run` routes every subcommand through an in-process scripted executor instead of the
real `claude` CLI: zero network calls, deterministic output, exit 0. Use it to validate the
pipeline end to end (`run` -> `score` -> `report`)
without spending a token or needing `ideas`/`superpowers` actually installed. `--dry-run`
also writes to a completely separate `runs-dry/` root instead of `runs/` (see above) --
dry-run and real runs never share a directory tree.

A typical full pass:

```
node run.js run
node run.js score
node run.js report
```

## Cost expectations

36 sessions, each up to `turn_cap` (25) assistant turns plus a matching sim-user turn per
round, plus scoring: one tier B judge call per (scenario, workflow, run) = 36 calls, and
5 tier C dimension judge calls x 2 order-swapped orderings = 10 calls per (scenario, run)
= 60 calls. A full pass is on the order of a few hundred `claude -p` invocations across
three pinned models. Run `--scenario`-scoped passes while iterating on the harness itself;
reserve full unscoped passes for real comparison runs.

## Metrics and known heuristics

Every metric spec section 13 pre-declares that this harness has real underlying data for
is reported -- including metrics where brainstorming wins (see `report.md`'s Tier A/B/C
tables). Two things are documented heuristics, not ground truth, and are labeled as such
in code comments and in `report.md`:

- **Two question-count heuristics exist.** `lib/driver.js`'s live `countQuestions`
  (used while a session is running, to decide nothing behaviorally -- it only feeds
  `transcript.totals.questions_asked`) counts **numbered lines only** (`"1. ...?"`).
  `lib/metrics.js`'s `tierA().questions_asked` -- computed post-hoc, once the full
  transcript is on disk -- counts numbered lines **plus** inline prose questions (e.g.
  `"Should it support Windows? And macOS?"`). **`report.md` uses tier A's post-hoc count
  as THE questions-asked metric.** The driver's live transcript total
  (`transcript.totals.questions_asked`) is informational only -- it is not fed into any
  paired table, comparison, or the success bar; it exists solely because the driver needs
  *some* signal while a session is in flight, before tier A's fuller heuristic can run
  over the finished transcript.
- **"Query discrepancy"** (spec section 13: "questions asked vs. minimum needed") has no
  precisely defined "minimum needed" in the spec. This harness uses a documented proxy:
  `minimumNeeded(scenario.meta)` = the scenario's planted-fact count plus its seeded
  ambiguity count -- the smallest set of things a perfect interviewer would need to ask
  about to resolve every fact and ambiguity. See `lib/report.js`'s `minimumNeeded`.
- **Tier B's "information gain per question"** (also named in spec section 13) is **not**
  computed -- `lib/metrics.js`'s `tierB()` returns `active_pct`, `critical_coverage`,
  and the silent/flagged assumption lists only. Rather than fabricate a number with no
  underlying judge call behind it, `report.md` reports assumption honesty instead, as the
  real counts of silent vs. flagged assumptions per spec (from the same tier B judge call).
- **The primary cost metric is assistant-only.** `lib/metrics.js`'s `tierA()` computes
  `output_tokens` (the metric the success bar's ">=30% fewer output tokens" bar and
  `report.md`'s Tier A table both use) from **assistant-role turns only** -- the
  interviewee's own token spend. It deliberately excludes the simulated user's reply
  turns, which are an artifact of this harness's own testing methodology, not a cost
  either workflow under test actually controls; summing every turn would silently inflate
  the primary metric with tokens neither workflow spent. The all-turns total is kept as a
  separate, clearly-secondary field, `output_tokens_all_roles`, rendered as its own
  informational row in `report.md`'s Tier A table -- never fed into the primary comparison
  or the success bar.

## Sandbox permission mode and retry

- **Permission mode.** Every assistant/interviewee invocation (`lib/driver.js`'s
  `buildAssistantInvocation`, both the kickoff and every `--resume`d turn) carries
  `--permission-mode <mode>`, defaulting to `acceptEdits` via `config.assistant_permission_mode`.
  A headless `claude -p` session otherwise cannot write files at all, which means the
  interviewee can never write its ledger or spec into the sandbox workspace and
  spec-detection (`findSpecFile`) never fires -- the session just idles to `turn_cap`
  instead of ending `spec-detected`. `acceptEdits` is reasonable here specifically because
  the target is the disposable, per-run sandbox workspace (`ensureSandbox`), not the
  repo or the host filesystem -- the harness preamble also tells the model to work only
  inside that directory. If a future run needs a different mode (e.g. `bypassPermissions`),
  set `assistant_permission_mode` in `config.json` -- it's a config edit, not a code
  change. The sim-user invocation (`buildSimUserInvocation`) never gets this flag: it's a
  stateless, text-only call that has no need to write anything.
- **Retry-once on CLI failure.** If a single assistant or sim-user executor call fails
  (non-zero exit, or the executor throws), `runSession` retries that exact same call once
  before giving up. This rides through a transient CLI failure (e.g. a bare exit 1 with
  empty stderr) without discarding an otherwise-healthy session. The retry is recorded
  honestly on the transcript: `transcript.retries` is a total count of retries actually
  attempted this session (`0` when nothing failed, never fabricated). If the retry also
  fails, the existing error path stands unchanged -- `ended_by` becomes `"error"`,
  `transcript.error` records the message, and `transcript.json` is still written with
  whatever turns completed before the failure.

## Sim-user protocol

`lib/simuser.js`'s `buildSimUserPrompt` is the only lever this harness has over the
simulated user's behavior -- it's a real model call, not code, so the protocol lives
entirely in the prompt's numbered rules. Beyond the original rules (answer only what's
asked, never rescue a wrap-up, stay grounded in the hidden doc, be concise, approve
tersely only once every open question is answered), two rules specifically guard against
**leakage**: a planted fact or latent constraint surfaces only when a question actually
targets the specific area it concerns -- never proactively, never "while we're at it" --
and the sim-user must never tease or hint that undisclosed information exists (e.g. it
must never say anything like "there are a couple of things you haven't asked about").
This closes an observed failure mode where the sim-user volunteered latent facts by
offering exactly that kind of unprompted hint, undermining tier B's elicitation-skill
measurement (a workflow that never had to ask still "found out").

## Tier D (automated) — downstream outcome

Spec section 13 names tier D ("the same fixed executor implements from each spec with no
access to the hidden doc; the held-out acceptance suite decides. Pass rate is the primary
metric of the whole benchmark") for a subset of scenarios. `tier-d.js` automates the
whole pipeline:

```
node tier-d.js run [--scenario <id>] [--dry-run]
```

Per scenario x side (`ideas`, `brainstorming`):

1. **Spec selection.** From `runs/<scenario>/<side>/run1..3`, pick the FIRST run whose
   `transcript.json` names `artifact.spec_path` AND that file still exists in the run's
   workspace. If no run in range qualifies (some scenario x side cells, e.g. s05 x
   brainstorming, plausibly never produce a spec at all), that side's pass is `null` with
   reason `"no spec produced"` -- never a guess.
2. **Fresh sandbox, built OUTSIDE the data tree.** The build happens in a fresh directory
   under `os.tmpdir()` -- ONE per-invocation temp root per `tier-d.js run`, one
   subdirectory per scenario/side underneath it -- never inside `runs/` or `runs-dry/`.
   `git init` best-effort, and the selected spec is copied in as `SPEC.md` (line endings
   normalized). This is an isolation fix: an earlier version built directly under
   `runs/tier-d/<scenario>/<side>/workspace`, and a fixed executor's own build process
   (which can run arbitrary build/test tooling inside its cwd) once destroyed real run
   data (`runs/s03`..`s05`) that happened to sit nearby on that shared tree. The temp root
   is removed (best-effort) once the whole `tier-d.js run` invocation finishes -- it is
   disposable build scratch space, never the audit trail.
3. **Fixed executor -- ONE call.** Pinned to `config.interviewee_model`,
   `--permission-mode acceptEdits`, prompt on stdin, `cwd` = the sandbox: "Implement the
   specification in SPEC.md, in this workspace. Work only from the spec; where it is
   silent, make reasonable choices and note them in IMPLEMENTATION-NOTES.md. Produce
   real, runnable code with tests where the spec calls for them. Do not ask questions -
   there is no user." It never sees the scenario's `hidden-doc.md` -- this is the whole
   point of tier D: the same executor, working only from what each workflow's interview
   actually produced. The call's raw CLI stdout and parsed text are persisted to
   `runs/tier-d/<scenario>/<side>/build-output.json` for forensics -- previously only the
   judge's verdicts were kept, so a build that misbehaved left no trace of what the
   executor actually said it did.
4. **Bounded artifact snapshot.** Once the build completes, the same bounded workspace
   inventory built for the judge prompt (file tree + contents of source/docs files, capped
   at ~6000 characters per file and ~40000 characters total; `SPEC.md`, `.git/`, and
   `node_modules/` excluded) is copied back into
   `runs/tier-d/<scenario>/<side>/artifacts/inventory.txt` for audit -- the ONLY thing that
   comes back from the disposable tmp sandbox into the data tree.
5. **Checklist judge -- ONE call.** Pinned to `config.judge_model`. The prompt carries the
   full `SPEC.md` text given to the executor, the scenario's `acceptance.md` checklist
   verbatim, and the bounded workspace inventory, plus a **dual judging standard**: an item
   describing BUILT BEHAVIOR is judged strictly against the workspace inventory ("pass"
   only if the code actually does it), while an item describing a PROCESS, PLAN, ROLLOUT,
   or COMPATIBILITY PROMISE is judged against the specification's stated plan instead
   ("pass" if the spec explicitly and credibly commits to it, even if not yet built) -- the
   same standard applied to whichever side produced the spec, so neither workflow is held
   to a stricter reading than the other. This closes a fairness gap an analyst flagged:
   without the spec text, any checklist item describing a process or compatibility promise
   was unjudgeable from the built inventory alone and either failed or came back
   unverifiable no matter how explicitly a spec committed to it. The judge decides
   required-vs-nice-to-have itself from each item's text (a literal `"(Nice-to-have)"`
   marker means optional) and returns strict JSON:
   `{"items": [{"text", "required", "verdict": "pass"|"fail"|"unverifiable"}, ...]}`.
6. **Pass rule (pre-declared) + graded metric.** A side's binary pass is still: **every
   required item's verdict is `"pass"`**. `"unverifiable"` is never a pass, and a
   failing/unverifiable nice-to-have never blocks a pass. Alongside it, a **graded
   required-items pass fraction** (`required items passing / required total`; `null` when
   there were zero required items or no judged items at all) fixes a floor effect: the
   binary rate alone can't distinguish a side that nailed 9 of 10 required items from one
   that nailed 0 of 10 -- both show up as a plain 0, a 0-vs-0 tie that hides a real gap.
   Per-item detail (every verdict, the spec run picked, any failure reason) is written to
   `runs/tier-d-details.json` for audit; the summary
   (`[{scenarioId, ideas_pass, brainstorming_pass, ideas_frac, brainstorming_frac}]` -- the
   two `_frac` fields are optional and back-compat with a pre-existing results file that
   never carried them) is written to `runs/tier-d-results.json`, which
   `node run.js report` already picks up automatically -- run `report` again after
   `tier-d.js` to render the Tier D section with the paired binary pass-rate table, the
   graded pass-fraction table (rendered only when at least one entry supplies fracs), and
   an exact-binomial (sign test) p-value on the binary rate. Without that file, `report.md`
   still renders Tier D as **"not run"**, plainly, rather than silently omitting the
   section or implying a null result is a loss. The success bar's tier D match-or-beat gate
   uses the graded fraction when it carries usable paired data, falling back to the binary
   rate otherwise -- `report.md` discloses which basis it used.

Parsing is defensive throughout, matching the rest of this harness's honesty invariants:
a malformed judge response, a failed executor call, or a failed judge call all produce
`pass: null` (and `frac: null`) for that side plus a recorded reason -- never a fabricated
verdict.

**Cost note.** Two build sessions (one fixed-executor call per side) plus two judge calls
per scenario -- 4 `claude -p` invocations per scenario, independent of `run`/`score`'s own
cost (see "Cost expectations" above).

`--dry-run` drives the identical pipeline against an in-process scripted fake executor --
the build sandbox itself still lives under `os.tmpdir()`, never under `runs-dry/` -- writing
its audit trail (`build-output.json`, `artifacts/`) under `runs-dry/tier-d/` (and
`runs-dry/tier-d-results.json` / `runs-dry/tier-d-details.json`) instead of `runs/` -- zero
network, exit 0, same segregation guarantee as `run.js`'s own `--dry-run`.

## Pinned versions

`report.md`'s "Pinned configuration" section records, best-effort, per the repo's honesty
invariants (never fabricate; null when unavailable): the three model IDs from
`config.json`, this repo's own `ideas` plugin version (read from `.claude-plugin/plugin.json`
when this checkout happens to sit next to one; falls back to the live probe below otherwise),
and (skipped entirely in `--dry-run`, so dry-run never spawns the `claude` CLI itself for a
version probe) the installed `claude` CLI version and both the `ideas` and `superpowers`
plugin versions via `claude plugin list --json` (falling back to parsing the plain-text
`claude plugin list` form if the JSON form is unavailable). Entries from `plugin list` are
keyed as `"<name>@<marketplace>"` with no separate name field -- the short name is derived
by splitting on the first `@`; a version of the literal string `"unknown"` (the CLI's own
placeholder) is normalized to `null` rather than reported as if it were a real version. Any
field that cannot be determined is recorded as `null (unavailable)`, never guessed. Note this
is narrower than "zero process
spawn" for `--dry-run` overall: `--dry-run` spawns no model calls and no `claude` CLI
process at all, but `git init` still runs per sandbox workspace on every run (dry-run
included, see `lib/driver.js`'s `tryGitInit`) -- best-effort, never a hard dependency.

## Pre-declared success bar

Quoted verbatim from the ideas design spec, section 13 (preserved at tag v0.3.1 in the ideas repo):

> ideas must match or beat brainstorming on tier D pass rate and the tier C composite,
> while spending at least 30% fewer output tokens per spec and imposing lower user
> burden. If it misses, the spec's claims are revised — never the numbers. (The
> plan-runner honesty invariants apply to our own benchmark first.)

`report.md` evaluates this as **PASS** / **FAIL** / **INSUFFICIENT-DATA** on all four
pre-declared conditions: >=30% fewer output tokens per spec AND a tier C composite that
matches or beats brainstorming AND strictly lower simulated-user burden ("imposing lower
user burden" -- lower, not lower-or-equal, so an exact tie does not pass) AND (when a
`tier-d-results.json` is present) a tier D pass rate that matches or beats brainstorming --
using the graded required-items pass fraction when the results file supplies it (see "Tier
D (automated)" above), falling back to the binary pass rate otherwise; the "Tier D
match-or-beat" bullet in `report.md` discloses which basis was used.
**WHEN the output-tokens family, the tier C composite family, or the user-burden family
is entirely null** (every scenario's paired value missing), the verdict is
**INSUFFICIENT-DATA** -- never a silently-favorable PASS or FAIL built on no data. When no
`tier-d-results.json` was supplied, tier D is simply not part of the verdict -- the
headline itself reads **"PASS (tier D not evaluated)"** or **"FAIL (tier D not
evaluated)"**, not a bare PASS/FAIL that reads as a complete four-condition verdict.

## Caveats (also in every `report.md`)

These are the plan header's flagged constraints, carried forward into every generated
report, not just this file:

- **Pilot N.** Ships with 6 pilot scenarios, below the spec's target N=15-20; any report
  with fewer than 15 *scored* scenarios (scenarios with actual run data, not just corpus
  size) is labeled **PILOT** -- the header states both counts, e.g. "1 of 6 scenario(s)
  scored". Scaling the corpus is a follow-up authoring task.
- **Prose-mode variant.** Headless runs cannot answer `AskUserQuestion`; the driver
  instructs both workflows, identically, to ask in numbered prose instead. Both sides run
  the same variant, but ideas' batching still shows up as fewer turns than a live
  `AskUserQuestion` session would produce.
- **Same-family judge.** The judge runs on a Claude model; cross-family judging would
  need an external API key this harness does not assume. Self-preference risk is
  mitigated by masking (titles stripped, section order normalized) and order-swap +
  averaging only -- not by using a different model family.
- **Sim-user relativity ("Lost in Simulation").** Results are a *relative* comparison of
  elicitation skill between the two workflows, not a claim about absolute human usability
  (spec appendix A.6). 2-3 scenarios must later be validated with a real human user.
- **Token accounting is best-effort.** Counts come from the `claude` CLI's JSON `usage`
  field; a turn whose usage is missing becomes `null` and is excluded from sums -- never
  fabricated. `output_tokens` (the primary cost metric) is labeled **lower bound (usage
  incomplete)** in `report.md`'s Tier A table whenever either side's per-run usage
  coverage is under 100%; the paired tables' `n`/`dropped` columns show scenario-level
  coverage, and a dedicated **Usage coverage** caveat line (see below) shows run-level
  coverage of the primary metric itself -- together making clear when a number is a
  complete count versus a lower bound, rather than claiming completeness the data doesn't
  support.
- **Usage coverage.** Every `report.md` records, per side, `runs with complete
  assistant-turn usage / total scored runs` (see `lib/metrics.js`'s
  `tierA().output_tokens_complete` and `lib/report.js`'s `usageCoverageForSide`).
  This is the counter the token-accounting caveat above refers to.
- **Judge temperature cannot be pinned via the CLI.** `claude -p --output-format json`
  exposes no temperature/sampling-control flag (see `lib/judge.js`'s
  `DETERMINISM_INSTRUCTION`), so the spec's pre-declared "judge at temperature 0" cannot
  be set through the CLI. Every judge call instead carries an explicit in-prompt
  instruction to answer as deterministically as possible -- a best-effort approximation,
  not a guarantee -- and every `report.md` discloses this in its Caveats section.

## Tests

```
node --test "tests/*.test.js"
```

(Pass the glob or explicit file paths -- a bare directory argument to `node --test` does
not resolve on this repo's Node version on Windows.)
