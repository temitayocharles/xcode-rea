import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";

/** Join two path fragments without destroying build-setting variables. */
export function joinPath(base, child) {
  if (!child) return base ?? "";
  if (isAbsolute(child) || /^\$[({]/.test(child)) return normalizeSlashes(child);
  if (!base) return normalizeSlashes(child);
  return normalizeSlashes(`${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`);
}

export function normalizeSlashes(value) {
  return sep === "/" ? value : value.split(sep).join("/");
}

export function toPosixRelative(from, to) {
  const relative = normalize(to).startsWith(normalize(from))
    ? normalize(to).slice(normalize(from).length).replace(/^\/+/, "")
    : to;
  return normalizeSlashes(relative);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value, length = 8) {
  return sha256(value).slice(0, length);
}

/** Convert a simple `*` glob into a regular expression. */
export function globToRegExp(glob) {
  const escaped = glob
    .split("")
    .map((char) => (char === "*" ? ".*" : char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`);
}

export function matchesGlob(value, glob) {
  if (!glob.includes("*")) return value === glob;
  return globToRegExp(glob).test(value);
}

/** Split a shell-style command fragment, honouring single and double quotes. */
export function splitShellWords(input) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

export function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^["'].*["']$/s.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

export function fileStem(value) {
  const name = basename(value);
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

export function dirName(value) {
  return dirname(value);
}

export function stableSortObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

export function ensureInside(root, candidate) {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export { join, basename, dirname, extname, normalize, isAbsolute };
