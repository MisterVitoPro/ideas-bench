# Scenario schema

Each scenario lives in its own directory under `bench/scenarios/` (e.g. `s01-cli-flag/`)
and carries exactly three files:

- `hidden-doc.md` -- the full requirements brief a real user would carry in their head,
  written in first person. It contains every planted fact (`meta.json`'s `facts` and
  `latent` entries) embedded naturally in prose. It never resolves the scenario's
  `ambiguities` -- those are gaps the brief leaves open on purpose, only closeable by
  asking. During a simulated interview, latent constraints are withheld by the
  simulated user unless a question targets them directly; the hidden doc itself still
  states them, because the user genuinely knows them.
- `acceptance.md` -- a held-out checklist (Markdown `- [ ]` items) written only from
  the hidden doc. It must not introduce any fact, constraint, or requirement the
  hidden doc doesn't support. Downstream tiers (Task 4/5) use this as the scoring
  ground truth.
- `meta.json` -- the machine-readable planted facts, in the shape below.

## `meta.json` shape

```json
{
  "id": "s01-cli-flag",
  "title": "Add a --since flag to the chlog CLI",
  "domain": "CLI feature",
  "facts": [
    { "id": "f1", "text": "...", "weight": "critical" },
    { "id": "f2", "text": "...", "weight": "nice" }
  ],
  "ambiguities": ["...", "...", "..."],
  "latent": ["...", "..."]
}
```

| Field | Type | Constraints |
|---|---|---|
| `id` | string | Must equal the scenario's directory name. |
| `title` | string | Non-empty, human-readable. |
| `domain` | string | Non-empty. The 6 shipped scenarios cover exactly: `CLI feature`, `schema migration`, `UI component`, `auth flow`, `data pipeline`, `game feature`. |
| `facts` | array | 8-12 entries. Each entry has a non-empty `id` (unique within the scenario), a non-empty `text`, and `weight` of `"critical"` or `"nice"`. At least 3 entries must be `"critical"`. Every fact must be an individually checkable statement -- not a vague theme. |
| `ambiguities` | array of strings | 3-4 entries, each non-empty. Things the hidden doc leaves genuinely unresolved; a good interview surfaces and resolves (or explicitly flags) these. |
| `latent` | array of strings | 1-2 entries, each non-empty. Facts a real user would only reveal if directly asked -- never volunteered. Must be true constraints stated in the hidden doc, not new facts invented at scoring time. |

## Loader contract

`bench/lib/scenarios.js` exports `loadScenarios(dir)`, which reads every immediate
subdirectory of `dir` as one scenario and returns:

```
[{ id, title, domain, hiddenDoc, acceptance, meta }, ...]
```

- `hiddenDoc` and `acceptance` are the raw file contents (strings).
- `meta` is the parsed `meta.json` object.
- Scenarios are returned in directory-name sort order.

If any scenario directory is missing a file, has invalid JSON, or violates any of the
constraints in the table above, `loadScenarios` throws a `ScenarioValidationError`
(`err.name === "ScenarioValidationError"`) whose `err.violations` array lists **every**
violation found across **every** malformed scenario in the directory -- it never
throws on just the first problem it finds, and it never silently drops a bad
scenario from the count.

## Adding a new scenario

1. Pick an unused domain-appropriate slug, e.g. `s07-<slug>/`, under `bench/scenarios/`.
2. Write `hidden-doc.md` first, in first person, weaving in 8-12 concrete facts
   (>=3 critical) and 1-2 latent constraints the user would only reveal if asked.
   Leave 3-4 genuine ambiguities unresolved.
3. Write `acceptance.md` as a checklist derived only from `hidden-doc.md`.
4. Write `meta.json` matching the shape above -- `id` must equal the directory name.
5. Run `node --test bench/tests/scenarios.test.js` to validate against the schema.
