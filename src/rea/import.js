import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const SETTING_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

const STOPWORDS = new Set([
  "ABSOLUTE",
  "APPL",
  "ARCHS",
  "ARM64",
  "BOOL",
  "BUILD",
  "CLASS",
  "DEBUG",
  "DEFAULT",
  "DESCRIPTION",
  "ERROR",
  "FALSE",
  "FRAMEWORK",
  "INFO",
  "JSON",
  "NAME",
  "NONE",
  "NOTICE",
  "NULL",
  "OBJECT",
  "PLIST",
  "PROPERTY",
  "RELEASE",
  "STATUS",
  "STRING",
  "TRUE",
  "TYPE",
  "UTF8",
  "VALUE",
  "WARNING",
  "X86_64",
  "YES",
]);

const SHORT_SETTINGS = new Set(["ACTION", "ARCHS", "SDKROOT", "CONFIGURATION", "LANGUAGE"]);

export function isCandidateSetting(name) {
  if (!SETTING_NAME.test(name)) return false;
  if (STOPWORDS.has(name)) return false;
  if (name.includes("_")) return true;
  if (SHORT_SETTINGS.has(name)) return true;
  if (name.startsWith("PRODUCT") || name.startsWith("SWIFT") || name.startsWith("CLANG")) {
    return true;
  }
  return false;
}

function walkStrings(node, visit) {
  if (typeof node === "string") {
    visit(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkStrings(item, visit);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key);
      walkStrings(value, visit);
    }
  }
}

function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const path = resolve(input);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (extname(name) === ".json") files.push(resolve(path, name));
      }
    } else if (extname(path) === ".json") {
      files.push(path);
    }
  }
  return files;
}

function addObservation(map, key, source) {
  if (!map[key]) map[key] = { observations: 0, sources: new Set() };
  map[key].observations += 1;
  map[key].sources.add(source);
}

function finalize(map) {
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((key) => [
        key,
        {
          observations: map[key].observations,
          sources: [...map[key].sources].sort(),
        },
      ]),
  );
}

/**
 * Extract candidate facts from arbitrary REA JSON. REA's contracts are rich and
 * versioned; this import is intentionally conservative and only records names
 * that occur in the evidence, with counts and source files so a human can audit
 * each one.
 */
export function extractEvidence(inputs) {
  const files = expandInputs(inputs);
  const sources = [];
  const settings = {};
  const classes = {};
  const frameworks = new Set();
  const libraries = new Set();

  for (const file of files) {
    const buffer = readFileSync(file);
    const relative = basename(file);
    sources.push({
      file: relative,
      path: file,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    });

    let data;
    try {
      data = JSON.parse(buffer.toString("utf8"));
    } catch {
      sources[sources.length - 1].parseError = "invalid JSON";
      continue;
    }

    walkStrings(data, (value) => {
      const trimmed = value.trim();
      if (isCandidateSetting(trimmed)) {
        addObservation(settings, trimmed, relative);
      }
      if (/^[A-Z][A-Za-z0-9]{2,}$/.test(trimmed) && !trimmed.includes("_")) {
        addObservation(classes, trimmed, relative);
      }
      for (const match of trimmed.matchAll(/([A-Za-z0-9_.+-]+)\.framework/g)) {
        frameworks.add(match[1]);
      }
      for (const match of trimmed.matchAll(/([A-Za-z0-9_.+-]+)\.(?:dylib|tbd)/g)) {
        libraries.add(match[1]);
      }
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources,
    buildSettings: finalize(settings),
    classes: finalize(classes),
    frameworks: [...frameworks].sort(),
    libraries: [...libraries].sort(),
  };
}

export function mergeEvidence(existing, incoming) {
  const base = existing ?? {
    schemaVersion: 1,
    generatedAt: null,
    sources: [],
    buildSettings: {},
    classes: {},
    frameworks: [],
    libraries: [],
  };
  const mergeMap = (left = {}, right = {}) => {
    const result = {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const a = left[key] ?? { observations: 0, sources: [] };
      const b = right[key] ?? { observations: 0, sources: [] };
      result[key] = {
        observations: a.observations + b.observations,
        sources: [...new Set([...a.sources, ...b.sources])].sort(),
      };
    }
    return Object.fromEntries(Object.keys(result).sort().map((key) => [key, result[key]]));
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [...(base.sources ?? []), ...(incoming.sources ?? [])],
    buildSettings: mergeMap(base.buildSettings, incoming.buildSettings),
    classes: mergeMap(base.classes, incoming.classes),
    frameworks: [...new Set([...(base.frameworks ?? []), ...(incoming.frameworks ?? [])])].sort(),
    libraries: [...new Set([...(base.libraries ?? []), ...(incoming.libraries ?? [])])].sort(),
  };
}

export function expandEvidenceInputs(inputs) {
  return expandInputs(inputs);
}
