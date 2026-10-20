import { basename, dirname, extname, normalize } from "node:path";
import { readXcconfig, parseConditionalKey } from "../xcode/xcconfig.js";
import { matchesGlob } from "../util/text.js";
import { genericDefaults, deploymentTargetSetting } from "./defaults.js";

const INHERITED_PATTERN = /\$\(inherited\)|\$\{inherited\}/g;

export function matchConditions(conditions, context) {
  for (const { name, value } of conditions) {
    switch (name) {
      case "sdk": {
        const candidates = [context.sdkName, context.sdkRoot].filter(Boolean);
        if (!candidates.some((candidate) => matchesGlob(candidate, value))) return false;
        break;
      }
      case "arch":
        if (!matchesGlob(context.arch ?? "", value)) return false;
        break;
      case "config":
        if (!matchesGlob(context.configuration ?? "", value)) return false;
        break;
      case "platform":
        if (!matchesGlob(context.platform ?? "", value)) return false;
        break;
      case "variant":
        if (!matchesGlob(context.variant ?? "normal", value)) return false;
        break;
      case "default":
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Apply one settings level. Xcode resolves several definitions of the same
 * setting by condition specificity: the matching definition with the most
 * conditions wins, and among equal conditions the last definition wins.
 * `$(inherited)` refers to the value from lower levels only.
 */
function layerValue(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue
      .flat(Infinity)
      .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.includes(" ") && !/^["'].*["']$/.test(entry) ? `"${entry}"` : entry))
      .join(" ");
  }
  if (rawValue && typeof rawValue === "object") return null;
  if (rawValue === null || rawValue === undefined) return null;
  return String(rawValue);
}

function applyLayer(accumulator, layer, context) {
  const entries = Object.entries(layer ?? {});
  const selected = new Map();
  const order = [];

  entries.forEach(([rawKey, rawValue], index) => {
    const normalizedValue = layerValue(rawValue);
    if (normalizedValue === null) return;
    const { key, conditions } = parseConditionalKey(rawKey);
    if (conditions.length > 0 && !matchConditions(conditions, context)) return;
    const candidate = {
      value: normalizedValue,
      specificity: conditions.length,
      index,
    };
    const existing = selected.get(key);
    if (!existing) {
      order.push(key);
      selected.set(key, candidate);
      return;
    }
    if (
      candidate.specificity > existing.specificity ||
      (candidate.specificity === existing.specificity && candidate.index > existing.index)
    ) {
      selected.set(key, candidate);
    }
  });

  for (const key of order) {
    const { value } = selected.get(key);
    accumulator[key] = value.includes("$(inherited)") || value.includes("${inherited}")
      ? value.replace(INHERITED_PATTERN, accumulator[key] ?? "")
      : value;
  }
  return accumulator;
}

function findConfiguration(project, ownerConfigurations, configurationName) {
  return (
    ownerConfigurations.configurations.find((config) => config.name === configurationName) ??
    null
  );
}

function xcconfigLayer(project, referenceId, cache, warnings) {
  if (!referenceId) return {};
  const path = project.resolveReferencePath(referenceId);
  if (!path) return {};
  let parsed = cache.get(path);
  if (!parsed) {
    try {
      parsed = readXcconfig(path, { warnings });
    } catch (error) {
      warnings.push(error.message);
      parsed = { settings: {} };
    }
    cache.set(path, parsed);
  }
  return parsed.settings;
}

function nextReference(input, from) {
  let best = -1;
  let opener = null;
  for (const token of ["$(", "${"]) {
    const index = input.indexOf(token, from);
    if (index !== -1 && (best === -1 || index < best)) {
      best = index;
      opener = token;
    }
  }
  if (best === -1) return null;
  const open = opener[1];
  const close = open === "(" ? ")" : "}";
  let depth = 1;
  for (let i = best + 2; i < input.length; i += 1) {
    if (input[i] === open) depth += 1;
    else if (input[i] === close) {
      depth -= 1;
      if (depth === 0) {
        return { start: best, end: i + 1, expression: input.slice(best + 2, i) };
      }
    }
  }
  return null;
}

function topLevelColon(value) {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

function splitModifiers(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function replaceAll(value, pattern, replacement) {
  return value.replace(new RegExp(pattern, "g"), replacement);
}

function c99Identifier(value) {
  const replaced = replaceAll(value, "[^A-Za-z0-9_]", "_");
  return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
}

function applyModifier(value, modifier, expand) {
  const eq = modifier.indexOf("=");
  const name = eq === -1 ? modifier : modifier.slice(0, eq);
  const argument = eq === -1 ? "" : modifier.slice(eq + 1);
  switch (name) {
    case "lower":
    case "lowercase":
      return value.toLowerCase();
    case "upper":
    case "uppercase":
      return value.toUpperCase();
    case "identifier":
      return replaceAll(value, "[^A-Za-z0-9_]", "_");
    case "rfc1034identifier":
      return replaceAll(value, "[^A-Za-z0-9.\\-]", "-");
    case "c99extidentifier":
      return c99Identifier(value);
    case "file":
      return basename(value);
    case "dir":
      return dirname(value);
    case "base":
      return basename(value, extname(value));
    case "suffix":
      return extname(value).replace(/^\./, "");
    case "standardizepath":
      return normalize(value);
    case "quote":
      return value.includes(" ") ? `"${value}"` : value;
    case "default":
      return value.length === 0 ? expand(argument) : value;
    case "path":
      return normalize(value);
    default:
      return value;
  }
}

/**
 * Expand `$(SETTING)` / `${SETTING}` references, including Xcode's `:modifier`
 * suffixes. Unknown settings expand to an empty string, mirroring xcodebuild.
 */
function normalizeValue(value) {
  let output = "";
  let quote = null;
  let pendingSpace = false;
  for (const char of value) {
    if (quote) {
      output += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && output.length > 0) output += " ";
      pendingSpace = false;
      quote = char;
      output += char;
      continue;
    }
    if (char === " " || char === "\t") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output.length > 0) output += " ";
    pendingSpace = false;
    output += char;
  }
  return output.trim();
}

export function expandSettings(rawSettings, options = {}) {
  const values = { ...rawSettings, ...(options.builtins ?? {}) };
  const cache = new Map();
  const resolving = new Set();
  const missing = new Set();

  const expand = (input) => {
    const text = String(input);
    let output = "";
    let index = 0;
    while (index < text.length) {
      const reference = nextReference(text, index);
      if (!reference) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, reference.start);
      output += evaluate(reference.expression);
      index = reference.end;
    }
    return output;
  };

  const evaluate = (expression) => {
    const colon = topLevelColon(expression);
    let name = (colon === -1 ? expression : expression.slice(0, colon)).trim();
    // Xcode expands nested references in the setting name itself:
    // $(MACOSX_DEPLOYMENT_TARGET_XCODE_$(XCODE_VERSION_MAJOR)).
    if (name.includes("$(") || name.includes("${")) name = expand(name).trim();
    let value;
    if (name === "inherited") {
      value = "";
    } else if (name.startsWith("$")) {
      value = expand(name);
    } else {
      value = resolveKey(name);
    }
    if (colon === -1) return value;
    const modifiers = splitModifiers(expression.slice(colon + 1));
    for (const modifier of modifiers) {
      value = applyModifier(value, modifier, expand);
    }
    return value;
  };

  const resolveKey = (name) => {
    if (cache.has(name)) return cache.get(name);
    if (resolving.has(name)) return "";
    const raw = values[name];
    if (raw === undefined) {
      missing.add(name);
      return "";
    }
    resolving.add(name);
    const result = expand(raw);
    resolving.delete(name);
    cache.set(name, result);
    return result;
  };

  const expanded = {};
  for (const key of Object.keys(values)) expanded[key] = normalizeValue(resolveKey(key));
  return { settings: expanded, missing };
}

export function buildSettingContext({
  configuration,
  platform,
  sdk,
  arch,
  variant = "normal",
}) {
  return {
    configuration,
    platform,
    sdkName: sdk?.name ?? platform,
    sdkRoot: sdk?.root ?? platform,
    sdkVersion: sdk?.version ?? null,
    arch,
    variant,
  };
}

/**
 * Resolve the complete build-setting table for a target (or for the project
 * when `target` is null), using Xcode's layering:
 *
 *   platform/product/generic defaults
 *   -> project .xcconfig
 *   -> project build settings
 *   -> target .xcconfig
 *   -> target build settings
 *   -> -xcconfig override file
 *   -> command-line KEY=VALUE overrides
 */
export function resolveBuildSettings(options) {
  const {
    project,
    target = null,
    configuration,
    platform,
    sdk = null,
    arch,
    hostArch = arch,
    derivedDataPath,
    developerDir = "",
    xcodeVersion = null,
    xcodeBuild = null,
    overrides = {},
    xcconfigPath = null,
    action = "build",
    variant = "normal",
    specDefaults = null,
  } = options;

  const warnings = [];
  const xcconfigCache = new Map();
  const context = buildSettingContext({ configuration, platform, sdk, arch, variant });

  const defaults = genericDefaults({
    project,
    projectPath: project.path,
    target,
    configuration,
    platform,
    sdk,
    arch,
    hostArch,
    derivedDataPath,
    developerDir,
    xcodeVersion,
    xcodeBuild,
    action,
  });

  const accumulator = {};
  const layers = [];

  const pushLayer = (name, layer) => {
    layers.push({ name, keys: Object.keys(layer ?? {}).length });
    applyLayer(accumulator, layer, context);
  };

  pushLayer("defaults", defaults);
  if (specDefaults) {
    pushLayer("xcode-spec-defaults", specDefaults);

    // .xcspec files from different Xcode components can declare generic or
    // empty defaults for settings that the active build context must compute.
    // Restore those computed values, while retaining authoritative spec
    // defaults for ordinary compiler options not in this contextual set.
    const contextualKeys = [
      "ACTION", "CONFIGURATION", "BUILD_DIR", "BUILD_ROOT",
      "BUILT_PRODUCTS_DIR", "CONFIGURATION_BUILD_DIR",
      "SYMROOT", "OBJROOT", "CONFIGURATION_TEMP_DIR", "TARGET_TEMP_DIR",
      "TARGET_BUILD_DIR", "DERIVED_FILE_DIR", "DERIVED_FILES_DIR",
      "SHARED_DERIVED_FILE_DIR", "MODULE_CACHE_DIR",
      "PROJECT_DIR", "SRCROOT", "SOURCE_ROOT", "PROJECT_FILE_PATH",
      "PROJECT_NAME", "TARGET_NAME", "TARGETNAME", "PRODUCT_NAME",
      "PRODUCT_MODULE_NAME", "SWIFT_MODULE_NAME", "FULL_PRODUCT_NAME",
      "WRAPPER_NAME", "WRAPPER_EXTENSION", "EXECUTABLE_PREFIX",
      "EXECUTABLE_EXTENSION", "EXECUTABLE_NAME", "EXECUTABLE_PATH",
      "INFOPLIST_PATH", "PRODUCT_TYPE", "PRODUCT_BUNDLE_PACKAGE_TYPE",
      "MACH_O_TYPE", "SKIP_INSTALL", "ARCHS", "CURRENT_ARCH", "HOST_ARCH",
      "DEVELOPER_DIR", "TOOLCHAIN_DIR", "PLATFORM_NAME", "SDKROOT",
      "SDK_NAME", "SDK_VERSION", "SDK_DIR", "DEPLOYMENT_TARGET",
      "MINIMUM_DEPLOYMENT_TARGET", "SUPPORTED_PLATFORMS",
      "CODE_SIGNING_ALLOWED", "CODE_SIGNING_REQUIRED",
      "CODE_SIGN_IDENTITY", "EXPANDED_CODE_SIGN_IDENTITY",
      "CONTENTS_FOLDER_PATH", "UNLOCALIZED_RESOURCES_FOLDER_PATH",
      "FRAMEWORKS_FOLDER_PATH", "PLUGINS_FOLDER_PATH",
      "SHARED_FRAMEWORKS_FOLDER_PATH",
      "XCODE_VERSION", "XCODE_VERSION_MAJOR", "XCODE_VERSION_MINOR",
      "XCODE_VERSION_ACTUAL", "XCODE_BUILD", "XCODE_PRODUCT_BUILD_VERSION",
      "PLATFORM_DIR", "PLATFORM_DEVELOPER_APPLICATIONS_DIR",
      "PLATFORM_DEVELOPER_BIN_DIR", "PLATFORM_DEVELOPER_LIBRARY_DIR",
      "PLATFORM_DEVELOPER_SDK_DIR", "PLATFORM_DEVELOPER_TOOLS_DIR",
      "PLATFORM_DEVELOPER_USR_DIR", "DEVELOPER_APPLICATIONS_DIR",
      "DEVELOPER_BIN_DIR", "DEVELOPER_FRAMEWORKS_DIR", "DEVELOPER_LIBRARY_DIR",
      "DEVELOPER_SDK_DIR", "DEVELOPER_TOOLS_DIR", "DEVELOPER_USR_DIR",
    ];
    const contextual = Object.fromEntries(
      contextualKeys.filter((key) => key in defaults).map((key) => [key, defaults[key]]),
    );
    pushLayer("contextual-defaults", contextual);
  }

  const projectConfig = findConfiguration(project, project.projectConfigurations(), configuration);
  if (projectConfig) {
    pushLayer(
      "project-xcconfig",
      xcconfigLayer(project, projectConfig.baseConfigurationReference, xcconfigCache, warnings),
    );
    pushLayer("project", projectConfig.buildSettings);
  }

  if (target) {
    const targetConfig = findConfiguration(project, project.targetConfigurations(target.id), configuration);
    if (targetConfig) {
      pushLayer(
        "target-xcconfig",
        xcconfigLayer(project, targetConfig.baseConfigurationReference, xcconfigCache, warnings),
      );
      pushLayer("target", targetConfig.buildSettings);
    }
  }

  if (xcconfigPath) {
    try {
      pushLayer("cli-xcconfig", readXcconfig(xcconfigPath, { warnings }).settings);
    } catch (error) {
      warnings.push(error.message);
    }
  }

  pushLayer("overrides", overrides);

  const { settings, missing } = expandSettings(accumulator);

  // Settings that must exist even when nothing referenced them.
  const finalSettings = { ...settings };
  if (!finalSettings.PRODUCT_MODULE_NAME) {
    finalSettings.PRODUCT_MODULE_NAME = finalSettings.PRODUCT_NAME
      ? c99Identifier(finalSettings.PRODUCT_NAME)
      : c99Identifier(target?.name ?? project.name);
  }
  if (!finalSettings.SWIFT_MODULE_NAME) {
    finalSettings.SWIFT_MODULE_NAME = finalSettings.PRODUCT_MODULE_NAME;
  }
  if (!finalSettings.DEPLOYMENT_TARGET) {
    const deploymentKey = deploymentTargetSetting(platform);
    finalSettings.DEPLOYMENT_TARGET = finalSettings[deploymentKey] ?? "";
  }

  return {
    settings: finalSettings,
    warnings,
    missing: [...missing].sort(),
    layers,
    context,
  };
}

/** Case-insensitive lookup helper used by planners. */
export function getSetting(settings, key, fallback = "") {
  if (settings[key] !== undefined) return settings[key];
  const upper = key.toUpperCase();
  if (settings[upper] !== undefined) return settings[upper];
  const found = Object.keys(settings).find((entry) => entry.toLowerCase() === key.toLowerCase());
  return found ? settings[found] : fallback;
}

export function splitSettingList(settings, key) {
  const value = getSetting(settings, key, "").trim();
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}
