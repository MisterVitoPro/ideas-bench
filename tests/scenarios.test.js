"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadScenarios } = require("../lib/scenarios");

const BENCH_ROOT = path.join(__dirname, "..");
const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");

const REQUIRED_DOMAINS = [
  "CLI feature",
  "schema migration",
  "UI component",
  "auth flow",
  "data pipeline",
  "game feature",
];

test("loadScenarios returns exactly 6 scenarios from bench/scenarios", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  assert.strictEqual(scenarios.length, 6, "expected exactly 6 shipped scenarios");
});

test("each scenario returns the documented shape", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    assert.ok(typeof s.id === "string" && s.id.length > 0, "id is a non-empty string");
    assert.ok(typeof s.title === "string" && s.title.length > 0, "title is a non-empty string");
    assert.ok(typeof s.domain === "string" && s.domain.length > 0, "domain is a non-empty string");
    assert.ok(typeof s.hiddenDoc === "string" && s.hiddenDoc.length > 0, "hiddenDoc is non-empty text");
    assert.ok(typeof s.acceptance === "string" && s.acceptance.length > 0, "acceptance is non-empty text");
    assert.ok(s.meta && typeof s.meta === "object", "meta is an object");
  }
});

test("each scenario has 8-12 facts including at least 3 critical", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    const facts = s.meta.facts;
    assert.ok(Array.isArray(facts), `${s.id} facts must be an array`);
    assert.ok(
      facts.length >= 8 && facts.length <= 12,
      `${s.id} facts count ${facts.length} out of [8,12]`
    );
    const critical = facts.filter((f) => f.weight === "critical");
    assert.ok(critical.length >= 3, `${s.id} needs >=3 critical facts, got ${critical.length}`);
    for (const f of facts) {
      assert.ok(["critical", "nice"].includes(f.weight), `${s.id} fact ${f.id} has invalid weight`);
      assert.ok(typeof f.text === "string" && f.text.trim().length > 0, `${s.id} fact ${f.id} has text`);
      assert.ok(typeof f.id === "string" && f.id.trim().length > 0, `${s.id} fact has an id`);
    }
  }
});

test("each scenario has 3-4 ambiguities", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    const amb = s.meta.ambiguities;
    assert.ok(Array.isArray(amb), `${s.id} ambiguities must be an array`);
    assert.ok(
      amb.length >= 3 && amb.length <= 4,
      `${s.id} ambiguities count ${amb.length} out of [3,4]`
    );
    for (const a of amb) {
      assert.ok(typeof a === "string" && a.trim().length > 0, `${s.id} ambiguity is non-empty text`);
    }
  }
});

test("each scenario has 1-2 latent constraints", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    const latent = s.meta.latent;
    assert.ok(Array.isArray(latent), `${s.id} latent must be an array`);
    assert.ok(
      latent.length >= 1 && latent.length <= 2,
      `${s.id} latent count ${latent.length} out of [1,2]`
    );
    for (const l of latent) {
      assert.ok(typeof l === "string" && l.trim().length > 0, `${s.id} latent item is non-empty text`);
    }
  }
});

test("the 6 scenarios cover the 6 required distinct domains", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  const domains = scenarios.map((s) => s.domain).sort();
  assert.deepStrictEqual(domains, [...REQUIRED_DOMAINS].sort());
});

test("acceptance.md is a non-trivial checklist derived from the hidden doc", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    const checkboxes = (s.acceptance.match(/^- \[ \]/gm) || []).length;
    assert.ok(checkboxes >= 6, `${s.id} acceptance.md should have a real checklist, got ${checkboxes} items`);
  }
});

test("hidden docs are written in first person", () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);
  for (const s of scenarios) {
    assert.match(s.hiddenDoc, /\bI\b|\bI'm\b|\bI've\b|\bmy\b|\bMy\b/, `${s.id} hidden-doc.md reads first-person`);
  }
});

test("malformed scenario throws a named ScenarioValidationError listing every violation", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scenario-fixture-"));
  try {
    const badDir = path.join(tmpRoot, "bad-scenario");
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, "hidden-doc.md"), "I am a user with a request.\n");
    fs.writeFileSync(path.join(badDir, "acceptance.md"), "- [ ] something\n");
    fs.writeFileSync(
      path.join(badDir, "meta.json"),
      JSON.stringify(
        {
          id: "not-matching-dir-name",
          title: "Broken scenario",
          domain: "CLI feature",
          facts: [
            { id: "f1", text: "only fact one", weight: "critical" },
            { id: "f2", text: "only fact two", weight: "urgent" },
          ],
          ambiguities: ["only one ambiguity"],
          latent: ["latent one", "latent two", "latent three"],
        },
        null,
        2
      )
    );

    assert.throws(
      () => loadScenarios(tmpRoot),
      (err) => {
        assert.strictEqual(err.name, "ScenarioValidationError");
        assert.ok(Array.isArray(err.violations), "error carries a violations array");
        assert.ok(err.violations.length >= 4, `expected multiple violations, got ${err.violations.length}`);
        const joined = err.violations.join("\n");
        assert.match(joined, /facts must have 8-12/);
        assert.match(joined, /at least 3 facts with weight "critical"/);
        assert.match(joined, /ambiguities must have 3-4/);
        assert.match(joined, /latent must have 1-2/);
        assert.match(joined, /weight must be "critical" or "nice"/);
        assert.match(joined, /meta\.id/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
