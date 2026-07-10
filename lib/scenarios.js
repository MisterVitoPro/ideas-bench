"use strict";
const fs = require("node:fs");
const path = require("node:path");

const VALID_WEIGHTS = new Set(["critical", "nice"]);

class ScenarioValidationError extends Error {
  constructor(violations) {
    super("Scenario validation failed:\n" + violations.map((v) => "- " + v).join("\n"));
    this.name = "ScenarioValidationError";
    this.violations = violations;
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Validates one scenario's meta.json against the schema documented in
// bench/scenarios/SCHEMA.md. Returns a list of human-readable violation
// strings (empty when meta is valid) -- never throws itself, so callers can
// accumulate violations across many scenarios before reporting.
function validateMeta(meta, dirId) {
  const violations = [];
  const prefix = `[${dirId}]`;

  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return [`${prefix} meta.json must be a JSON object`];
  }

  if (!isNonEmptyString(meta.id)) {
    violations.push(`${prefix} meta.id must be a non-empty string`);
  } else if (meta.id !== dirId) {
    violations.push(`${prefix} meta.id ("${meta.id}") must match its directory name ("${dirId}")`);
  }

  if (!isNonEmptyString(meta.title)) {
    violations.push(`${prefix} meta.title must be a non-empty string`);
  }

  if (!isNonEmptyString(meta.domain)) {
    violations.push(`${prefix} meta.domain must be a non-empty string`);
  }

  if (!Array.isArray(meta.facts)) {
    violations.push(`${prefix} meta.facts must be an array`);
  } else {
    if (meta.facts.length < 8 || meta.facts.length > 12) {
      violations.push(`${prefix} meta.facts must have 8-12 entries, got ${meta.facts.length}`);
    }
    const seenIds = new Set();
    let criticalCount = 0;
    meta.facts.forEach((fact, i) => {
      const fp = `${prefix} facts[${i}]`;
      if (!fact || typeof fact !== "object") {
        violations.push(`${fp} must be an object`);
        return;
      }
      if (!isNonEmptyString(fact.id)) {
        violations.push(`${fp}.id must be a non-empty string`);
      } else if (seenIds.has(fact.id)) {
        violations.push(`${fp}.id ("${fact.id}") is duplicated within the scenario`);
      } else {
        seenIds.add(fact.id);
      }
      if (!isNonEmptyString(fact.text)) {
        violations.push(`${fp}.text must be a non-empty string`);
      }
      if (!VALID_WEIGHTS.has(fact.weight)) {
        violations.push(`${fp}.weight must be "critical" or "nice", got ${JSON.stringify(fact.weight)}`);
      } else if (fact.weight === "critical") {
        criticalCount += 1;
      }
    });
    if (criticalCount < 3) {
      violations.push(
        `${prefix} meta.facts must include at least 3 facts with weight "critical", got ${criticalCount}`
      );
    }
  }

  if (!Array.isArray(meta.ambiguities)) {
    violations.push(`${prefix} meta.ambiguities must be an array`);
  } else {
    if (meta.ambiguities.length < 3 || meta.ambiguities.length > 4) {
      violations.push(`${prefix} meta.ambiguities must have 3-4 entries, got ${meta.ambiguities.length}`);
    }
    meta.ambiguities.forEach((a, i) => {
      if (!isNonEmptyString(a)) {
        violations.push(`${prefix} ambiguities[${i}] must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(meta.latent)) {
    violations.push(`${prefix} meta.latent must be an array`);
  } else {
    if (meta.latent.length < 1 || meta.latent.length > 2) {
      violations.push(`${prefix} meta.latent must have 1-2 entries, got ${meta.latent.length}`);
    }
    meta.latent.forEach((l, i) => {
      if (!isNonEmptyString(l)) {
        violations.push(`${prefix} latent[${i}] must be a non-empty string`);
      }
    });
  }

  return violations;
}

// loadScenarios(dir) -> [{id, title, domain, hiddenDoc, acceptance, meta}]
//
// Reads every immediate subdirectory of `dir` as a scenario, expecting
// hidden-doc.md, acceptance.md, and meta.json in each. Validates every
// scenario's meta.json against the schema (see SCHEMA.md) and, if any
// scenario is malformed, throws a single ScenarioValidationError listing
// every violation across every malformed scenario -- never a partial
// silent-pass result.
function loadScenarios(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const violations = [];
  const scenarios = [];

  for (const id of entries) {
    const scenarioDir = path.join(dir, id);
    const hiddenDocPath = path.join(scenarioDir, "hidden-doc.md");
    const acceptancePath = path.join(scenarioDir, "acceptance.md");
    const metaPath = path.join(scenarioDir, "meta.json");

    let hiddenDoc = null;
    let acceptance = null;
    let meta = null;

    if (!fs.existsSync(hiddenDocPath)) {
      violations.push(`[${id}] missing hidden-doc.md`);
    } else {
      // Ingestion seam: these are checked-into-git fixtures that a CRLF
      // (autocrlf) checkout can materialize with \r\n -- normalize once here
      // so downstream prompt assembly (buildSimUserPrompt, buildFactJudgePrompt)
      // always sees LF, regardless of the checkout's line-ending config.
      hiddenDoc = fs.readFileSync(hiddenDocPath, "utf8").replace(/\r\n/g, "\n");
      if (!isNonEmptyString(hiddenDoc)) {
        violations.push(`[${id}] hidden-doc.md must not be empty`);
      }
    }

    if (!fs.existsSync(acceptancePath)) {
      violations.push(`[${id}] missing acceptance.md`);
    } else {
      acceptance = fs.readFileSync(acceptancePath, "utf8").replace(/\r\n/g, "\n");
      if (!isNonEmptyString(acceptance)) {
        violations.push(`[${id}] acceptance.md must not be empty`);
      }
    }

    if (!fs.existsSync(metaPath)) {
      violations.push(`[${id}] missing meta.json`);
    } else {
      const raw = fs.readFileSync(metaPath, "utf8");
      try {
        meta = JSON.parse(raw);
      } catch (err) {
        violations.push(`[${id}] meta.json is not valid JSON: ${err.message}`);
      }
      if (meta !== null) {
        violations.push(...validateMeta(meta, id));
      }
    }

    scenarios.push({
      id,
      title: meta && isNonEmptyString(meta.title) ? meta.title : id,
      domain: meta && isNonEmptyString(meta.domain) ? meta.domain : null,
      hiddenDoc,
      acceptance,
      meta,
    });
  }

  if (violations.length > 0) {
    throw new ScenarioValidationError(violations);
  }

  return scenarios;
}

module.exports = { loadScenarios, validateMeta, ScenarioValidationError };
