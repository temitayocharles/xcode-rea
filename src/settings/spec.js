import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parsePlist } from "../plist/index.js";

/**
 * Xcode ships build-setting definitions as `.xcspec` property lists. They are
 * the authoritative source for a setting's default value, so reading them is
 * the cheapest way to stay compatible with the installed Xcode.
 *
 * Modern Xcode versions split specs across several plugin bundles; we scan the
 * documented locations and a bounded set of extra roots.
 */
const SPEC_ROOTS = [
  ["Library", "Xcode", "Specifications"],
  ["Library", "Xcode", "PlugIns"],
  ["PlugIns", "XCBBuildService.bundle", "Contents", "PlugIns", "XCBSpecifications.ideplugin", "Contents", "Resources"],
  ["PlugIns", "XCBBuildService.bundle", "Contents", "Resources"],
];

const PLATFORM_DIR_NAMES = {
  iphoneos: "iPhoneOS.platform",
  iphonesimulator: "iPhoneSimulator.platform",
  macosx: "MacOSX.platform",
  appletvos: "AppleTVOS.platform",
  appletvsimulator: "AppleTVSimulator.platform",
  watchos: "WatchOS.platform",
  watchsimulator: "WatchSimulator.platform",
  xros: "XROS.platform",
  xrsimulator: "XRSimulator.platform",
};

const PLATFORM_SPEC_ROOTS = [
  ["Developer", "Library", "Xcode", "Specifications"],
  ["Developer", "Library", "Xcode", "PlugIns"],
  ["Developer", "Library", "Specifications"],
];

function walkSpecFiles(root, depth = 0, out = []) {
  if (depth > 6 || !existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".bundle") || entry.name.endsWith(".framework")) continue;
      walkSpecFiles(path, depth + 1, out);
    } else if (entry.name.endsWith(".xcspec")) {
      out.push(path);
    }
  }
  return out;
}

function collectDefinition(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectDefinition(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.DefaultValue !== undefined && (node.Name || node.Identifier)) {
    out.push({
      name: node.Name ?? node.Identifier,
      identifier: node.Identifier ?? null,
      defaultValue: node.DefaultValue,
      type: node.Type ?? null,
      allowedValues: node.AllowedValues ?? null,
    });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectDefinition(value, out);
  }
}

export function parseSpecFile(path) {
  const text = readFileSync(path, "utf8");
  const tree = parsePlist(text);
  const definitions = [];
  collectDefinition(tree, definitions);
  return definitions;
}

/**
 * Read every discoverable build-setting default from the installed Xcode.
 * Returns `{ defaults, files, definitions, warnings }`.
 */
const specCache = new Map();
const CACHE_VERSION = 3;

function diskCacheFile(cacheKey) {
  const root =
    process.env.XCL_CACHE_DIR ?? join(homedir(), "Library", "Caches", "xcl");
  const digest = createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
  return { root, file: join(root, `xcspec-${digest}.json`) };
}

function readDiskCache(cacheKey) {
  if (process.env.XCL_NO_CACHE === "1") return null;
  try {
    const { file } = diskCacheFile(cacheKey);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed.cacheVersion !== CACHE_VERSION || parsed.cacheKey !== cacheKey) return null;
    if (!parsed.defaults || typeof parsed.defaults !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(cacheKey, payload) {
  if (process.env.XCL_NO_CACHE === "1") return;
  try {
    const { root, file } = diskCacheFile(cacheKey);
    mkdirSync(root, { recursive: true });
    writeFileSync(file, JSON.stringify({ cacheVersion: CACHE_VERSION, cacheKey, ...payload }));
  } catch {
    // A read-only or full cache directory must never break a build.
  }
}

export function loadXcodeSpecDefaults({ developerDir, platforms = null } = {}) {
  const cacheKey = `${developerDir ?? ""}|${platforms ? [...platforms].sort().join(",") : "*"}`;
  if (specCache.has(cacheKey)) return specCache.get(cacheKey);
  const cached = readDiskCache(cacheKey);
  if (cached) {
    specCache.set(cacheKey, cached);
    return cached;
  }
  const files = [];
  const warnings = [];
  if (developerDir) {
    for (const segments of SPEC_ROOTS) {
      walkSpecFiles(join(developerDir, ...segments), 0, files);
    }
    const platformRoot = join(developerDir, "Platforms");
    if (existsSync(platformRoot)) {
      for (const name of readdirSync(platformRoot)) {
        if (!name.endsWith(".platform")) continue;
        if (platforms) {
          const allowed = platforms.map((platform) => PLATFORM_DIR_NAMES[platform] ?? platform);
          if (!allowed.includes(name)) continue;
        }
        for (const segments of PLATFORM_SPEC_ROOTS) {
          walkSpecFiles(join(platformRoot, name, ...segments), 0, files);
        }
      }
    }
  }

  const defaults = {};
  const definitions = {};
  for (const file of [...new Set(files)].sort()) {
    try {
      for (const definition of parseSpecFile(file)) {
        if (!definition.name || definition.defaultValue === undefined) continue;
        if (typeof definition.defaultValue === "object") continue;
        if (defaults[definition.name] === undefined) {
          defaults[definition.name] = String(definition.defaultValue);
        }
        definitions[definition.name] ??= {
          source: file,
          identifier: definition.identifier,
          type: definition.type,
          allowedValues: definition.allowedValues,
        };
      }
    } catch (error) {
      warnings.push(`${file}: ${error.message}`);
    }
  }

  const result = {
    defaults,
    definitions,
    files: [...new Set(files)].sort(),
    warnings,
  };
  if (files.length > 0 && warnings.length === 0) writeDiskCache(cacheKey, result);
  specCache.set(cacheKey, result);
  return result;
}
