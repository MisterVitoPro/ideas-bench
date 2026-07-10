# bench

The paired, blind, simulated-user benchmark comparing `/ideas:interview` against
`superpowers:brainstorming`, per the design spec's measurement section
(`docs/specs/2026-07-08-ideas-design.md`, section 13).

`bench/` is dev tooling for this repo, not part of the plugin payload it ships --
it does not participate in the plugin's version bump.

This file is a stub. It will be completed in a later task with: prerequisites
(ideas + superpowers installed, pinned versions), the full run matrix, cost
expectations, and the tier D downstream-execution procedure.

## What's here so far

- `config.json` -- pinned models, run counts, and per-workflow kickoff templates.
- `scenarios/` -- the scenario corpus (see `scenarios/SCHEMA.md` for the format)
  and its loader, `lib/scenarios.js`.
- `tests/` -- hermetic `node --test` coverage for the pieces implemented so far.

Run the scenario tests with:

```
node --test bench/tests/
```

`bench/runs/` (generated run output) is gitignored -- never commit it.
