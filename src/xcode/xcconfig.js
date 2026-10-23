import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { normalizeSlashes } from "../util/text.js";

export class XcconfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "XcconfigError";
  }
}

/** Remove `//` and block comments while respecting quotes. */
function stripComments(line) {
  let result = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      result += char;
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (char === "/" && line[i + 1] === "/") {
      if (result.trim().length === 0 || /\s$/.test(result)) break;
    }
    if (char === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    result += char;
  }
  return result;
}

/** Split `KEY[cond=value] = VALUE` into its parts. */
export function splitAssignment(line) {
  let bracketDepth = 0;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "=" && bracketDepth === 0) {
      return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    }
  }
  return null;
}

export function parseConditionalKey(key) {
  const match = /^(.*?)((?:\[[^\]]*\])+)$/.exec(key);
  if (!match) return { key, conditions: [] };
  const conditions = [...match[2].matchAll(/\[([^\]]*)\]/g)].map((entry) => {
    const eq = entry[1].indexOf("=");
    if (eq === -1) return { name: entry[1].trim(), value: "" };
    return {
      name: entry[1].slice(0, eq).trim(),
      value: entry[1].slice(eq + 1).trim(),
    };
  });
  return { key: match[1].trim(), conditions };
}

/**
 * Parse an `.xcconfig` file, resolving `#include` directives.
 *
 * @param {string} text
 * @param {{filePath?: string, readFile?: (path: string) => string, seen?: Set<string>, warnings?: string[]}} [options]
 */
export function parseXcconfig(text, options = {}) {
  const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
  const filePath = options.filePath ?? null;
  const seen = options.seen ?? new Set();
  const warnings = options.warnings ?? [];
  const settings = {};
  const includes = [];

  if (filePath) {
    if (seen.has(filePath)) {
      throw new XcconfigError(`cyclic #include detected at ${filePath}`);
    }
    seen.add(filePath);
  }

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let pending = "";

  for (const rawLine of lines) {
    let line = pending + rawLine;
    pending = "";
    if (/\\\s*$/.test(line)) {
      pending = `${line.replace(/\\\s*$/, "")} `;
      continue;
    }
    const withoutComment = stripComments(line);
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;

    const includeMatch = /^#include(\?)?\s*(?:"([^"]+)"|<([^>]+)>)/.exec(trimmed);
    if (includeMatch) {
      const optional = includeMatch[1] === "?";
      const includePath = includeMatch[2] ?? includeMatch[3];
      const resolved = isAbsolute(includePath)
        ? includePath
        : resolve(filePath ? dirname(filePath) : process.cwd(), includePath);
      includes.push({ path: resolved, optional });
      let includedText = null;
      try {
        includedText = readFile(resolved);
      } catch {
        if (!optional) warnings.push(`missing #include ${includePath} (resolved to ${resolved})`);
        continue;
      }
      if (filePath) seen.delete(filePath);
      const included = parseXcconfig(includedText, {
        filePath: resolved,
        readFile,
        seen,
        warnings,
      });
      Object.assign(settings, included.settings);
      includes.push(...included.includes);
      if (filePath) seen.add(filePath);
      continue;
    }

    const assignment = splitAssignment(trimmed);
    if (!assignment) {
      warnings.push(`ignored unparseable line: ${trimmed}`);
      continue;
    }
    settings[assignment.key] = assignment.value;
  }

  if (filePath) seen.delete(filePath);
  return { settings, includes, warnings };
}

export function readXcconfig(filePath, options = {}) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new XcconfigError(`cannot read ${filePath}: ${error.message}`, { cause: error });
  }
  return parseXcconfig(text, { ...options, filePath: normalizeSlashes(filePath) });
}
