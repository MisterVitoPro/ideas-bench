# bench run report (PILOT)

6 of 6 scenario(s) scored -- **PILOT**: below spec section 13's target N of 15-20. 3 run(s) per scenario per workflow.

## Pinned configuration

- Interviewee model: claude-sonnet-5
- Simulated-user model: claude-sonnet-5
- Judge model: claude-opus-4-8
- Turn cap: 25
- ideas plugin version: 0.2.3
- superpowers plugin version: 6.1.1
- claude CLI version: 2.1.207 (Claude Code)

## Tier A — cost/burden (deterministic from transcripts)

| Metric | ideas mean | brainstorming mean | median diff (ideas - brainstorming) | Wilcoxon p | n (scenarios) | dropped |
|---|---|---|---|---|---|---|
| Output tokens per spec, assistant-only (primary cost metric) | 23261.72 | 18873.94 | 3719.83 | 0.0313 | 6 | 0 |
| Output tokens per spec, all roles (informational -- includes sim-user turns, never the primary metric) | 23778.89 | 19581.28 | 3619.33 | 0.0313 | 6 | 0 |
| Questions asked (tier A post-hoc count -- see README.md) | 14.83 | 19.28 | -2.50 | 0.0625 | 6 | 0 |
| Turn count | 11.44 | 31.89 | -17.67 | 0.0313 | 6 | 0 |
| Simulated-user burden tokens (approximate) | 307.00 | 502.72 | -151.83 | 0.0625 | 6 | 0 |
| Query discrepancy (questions asked minus minimum needed) | 0.83 | 5.28 | -2.50 | 0.0625 | 6 | 0 |

## Tier B — elicitation vs. ground truth

| Metric | ideas mean | brainstorming mean | median diff (ideas - brainstorming) | Wilcoxon p | n (scenarios) | dropped |
|---|---|---|---|---|---|---|
| Active Elicited % (headline interview-skill metric) | 0.48 | 0.49 | -0.02 | 1.0000 | 6 | 0 |
| Critical-fact coverage (weighted) | 0.74 | 0.83 | -0.06 | 0.2500 | 6 | 0 |
| Silent assumptions per spec (avg count -- lower is more honest) | 1.75 | 1.78 | 0.08 | 0.8125 | 6 | 0 |
| Flagged assumptions per spec (avg count) | 5.00 | 0.78 | 3.50 | 0.0313 | 6 | 0 |

## Tier C — spec quality (LLM judge, masked + order-swapped, 1-5 anchored rubric)

| Metric | ideas mean | brainstorming mean | median diff (ideas - brainstorming) | Wilcoxon p | n (scenarios) | dropped |
|---|---|---|---|---|---|---|
| completeness | 4.19 | 4.25 | -0.08 | 0.8750 | 6 | 0 |
| unambiguity | 3.86 | 4.36 | -0.75 | 0.1563 | 6 | 0 |
| testability | 4.44 | 4.47 | 0.00 | 1.0000 | 6 | 0 |
| consistency | 4.17 | 4.33 | -0.25 | 0.5000 | 6 | 0 |
| assumption_honesty | 4.89 | 3.03 | 1.75 | 0.0313 | 6 | 0 |
| **Composite (mean of available dimensions)** | 4.31 | 4.09 | 0.18 | 0.3125 | 6 | 0 |

## Tier D — downstream outcome (subset of 6-8 scenarios)

**not run.** Tier D is not automated in this version -- it is a documented manual procedure (see README.md): the same fixed executor implements from each spec with no access to the hidden doc, and the held-out acceptance suite decides pass/fail. Supply a tier-d results file to render this section.

## Success bar

> ideas must match or beat brainstorming on tier D pass rate and the tier C composite, while spending at least 30% fewer output tokens per spec and imposing lower user burden. If it misses, the spec's claims are revised — never the numbers. (The plan-runner honesty invariants apply to our own benchmark first.)

**Verdict: FAIL (tier D not evaluated)**

- Token reduction: -23.2% (bar: >=30%) -- FAIL
- Tier C composite match-or-beat: PASS
- User burden strictly lower: PASS
- Tier D match-or-beat: not run (not evaluated)

## Caveats

- **Pilot N.** This report covers 6 scenario(s), labeled **PILOT**; spec section 13 targets N=15-20. Scaling the scenario corpus is a follow-up authoring task, not a claim this report makes.
- **Prose-mode variant.** Headless runs cannot answer AskUserQuestion; the driver instructs both workflows to ask in numbered prose instead. Both sides run the same variant, but ideas' batching still shows as fewer turns than a live AskUserQuestion session would.
- **Same-family judge.** The judge runs on a Claude model -- cross-family judging would need an external API key this harness does not assume. Self-preference risk is mitigated by masking + order-swap only, not by a different model family.
- **Sim-user relativity ("Lost in Simulation").** Results are a relative comparison of elicitation skill between the two workflows, not a claim about absolute human usability; 2-3 scenarios must later be validated with a real human user.
- **Token accounting is best-effort.** Counts come from the claude CLI's JSON usage field; a turn with missing usage becomes null and is excluded from sums, never fabricated. The output_tokens row (the primary cost metric, assistant-only turns) is labeled **lower bound (usage incomplete)** whenever the usage-coverage counter below is under 100% for either side -- the paired-table n/dropped columns show scenario-level coverage; the usage-coverage line below shows run-level coverage of the primary metric itself.
- **Usage coverage (primary cost metric).** ideas: 18/18 scored run(s) (100.0%) reported complete usage; brainstorming: 18/18 scored run(s) (100.0%) reported complete usage. A run missing usage on any assistant turn contributes 0 for that turn, never a fabricated guess -- see the output_tokens row's label above when coverage is under 100%.
- **Judge temperature cannot be pinned via the CLI.** The `claude -p --output-format json` mode this harness invokes exposes no temperature/sampling-control flag (see lib/judge.js's DETERMINISM_INSTRUCTION). Every judge call instead carries an explicit in-prompt instruction to answer as deterministically as possible -- a best-effort approximation of the spec's pre-declared "judge at temperature 0," not a guarantee.
- **Pinned versions are best-effort.** ideas/superpowers plugin versions and model IDs are recorded from config.json plus `claude plugin` output where feasible; unavailable values are recorded as null, never guessed.
