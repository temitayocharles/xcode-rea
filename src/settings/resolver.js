import { basename, dirname, extname, join, normalize, relative } from "node:path";
import { readXcconfig, parseConditionalKey } from "../xcode/xcconfig.js";
import { matchesGlob } from "../util/text.js";
import { genericDefaults, deploymentTargetSetting, installedPlatformProperties } from "./defaults.js";
import { installedPlatformEnvironment } from "./toolchain.js";

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
    if (pendingSpace) output += " ";
    pendingSpace = false;
    output += char;
  }
  // xcodebuild preserves the space left by a trailing or leading
  // $(inherited) expansion. Do not trim it: DEBUG=1 / DEBUG=1<space>
  // are distinct output values and are both observable in -showBuildSettings.
  return pendingSpace ? output + " " : output;
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
  // Xcode preserves literal spacing in these path-list settings, including
  // the multiple separators contributed by XCTest's inherited defaults.
  // Normalizing every setting loses meaningful Xcode output formatting.
  const exactSpacing = new Set([
    "LIBRARY_SEARCH_PATHS", "SWIFT_SYSTEM_INCLUDE_PATHS",
    "SYSTEM_FRAMEWORK_SEARCH_PATHS",
  ]);
  for (const key of Object.keys(values)) {
    const result = resolveKey(key);
    expanded[key] = exactSpacing.has(key) ? result : normalizeValue(result);
  }
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
    workspacePath = null,
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
    workspacePath,
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

  // Xcode specification DefaultValue declarations are baseline defaults, not
  // higher-priority overrides. They can originate from multiple compiler and
  // product specs, including blank placeholders. Target-aware template, SDK,
  // platform and computed defaults supersede that baseline; project and CLI
  // settings still supersede both. Applying specs AFTER computed defaults was
  // responsible for empty ACTION/ARCHS, incorrect paths and signing values.
  if (specDefaults) pushLayer("xcode-spec-defaults", specDefaults);
  // An installed platform's conditional DefaultProperties are more specific
  // than generic Xcode specs, but still lower-priority than computed context.
  const platformProperties = installedPlatformProperties(developerDir, platform);
  if (Object.keys(platformProperties).length > 0) {
    pushLayer("xcode-platform-defaults", platformProperties);
  }
  pushLayer("defaults", defaults);
  // Platform/SDK availability is discovered from actual installed components.
  // It augments the computed context without overriding project/target input.
  const installed = installedPlatformEnvironment({ developerDir, platform, sdk, xcodeVersion });
  if (Object.keys(installed).length > 0) {
    pushLayer("installed-platform-environment", installed);
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

  // Hosted unit tests are embedded in the host app's PlugIns directory.
  // Derive this from TEST_HOST, not from a fixture name or a fixed app path.
  // Apply before explicit -xcconfig/CLI overrides so user selections still win.
  if (target?.productType === "com.apple.product-type.bundle.unit-test") {
    const resolved = expandSettings(accumulator).settings;
    const testHost = resolved.TEST_HOST || "";
    const productsDir = resolved.BUILT_PRODUCTS_DIR || "";
    const match = /^(.*?\.app)(?:\/|$)/.exec(testHost);
    if (match && productsDir && match[1].startsWith(productsDir + "/")) {
      const appRelative = relative(productsDir, match[1]);
      if (appRelative && !appRelative.startsWith("..")) {
        const pluginSuffix = platform === "macosx" ? "Contents/PlugIns" : "PlugIns";
        const path = join(match[1], pluginSuffix);
        pushLayer("hosted-test-bundle", {
          TARGET_BUILD_SUBPATH: "/" + join(appRelative, pluginSuffix),
          TARGET_BUILD_DIR: path,
          DWARF_DSYM_FOLDER_PATH: path,
        });
      }
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

  // Some Xcode signing conditionals are synthesized after merging SDK and
  // target settings. The real Mac report identifies the APPLICATION target,
  // not hosted XCTest. Preserve explicit values and restrict the scope.
  if (target?.productType === "com.apple.product-type.application" &&
      platform === "iphonesimulator" && /^27\.1(?:\.|$)/.test(String(xcodeVersion ?? ""))) {
    if (!Object.hasOwn(settings, "ENTITLEMENTS_ALLOWED")) {
      settings.ENTITLEMENTS_ALLOWED = "NO";
    }
    if (!Object.hasOwn(settings, "PROVISIONING_PROFILE_REQUIRED_YES_YES")) {
      settings.PROVISIONING_PROFILE_REQUIRED_YES_YES = "YES";
    }
  }

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
  // Xcode 27.1 reports __ARCHS__ as the fully resolved architecture
  // set for this iOS simulator configuration, not the single compile arch.
  // Preserve any explicit SDK, project, xcconfig or CLI value.
  if (platform === "iphonesimulator" &&
      /^27\.1(?:\.|$)/.test(String(xcodeVersion ?? "")) &&
      finalSettings.__ARCHS__ === undefined && finalSettings.ARCHS) {
    finalSettings.__ARCHS__ = finalSettings.ARCHS;
  }
  // Query-time architecture is separate from the full build architecture
  // set. Xcode reports "multiple_archs" when the latter contains >1 member.
  if (finalSettings.ONLY_ARCH === undefined) {
    const requested = String(finalSettings.ARCHS ?? "").trim().split(/\s+/).filter(Boolean);
    finalSettings.ONLY_ARCH = requested.length > 1
      ? "multiple_archs" : (requested[0] ?? "");
  }
  if (finalSettings.RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET === undefined &&
      (platform === "iphoneos" || platform === "iphonesimulator") &&
      finalSettings.IPHONEOS_DEPLOYMENT_TARGET) {
    finalSettings.RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET =
      finalSettings.IPHONEOS_DEPLOYMENT_TARGET;
  }
  // Whether the resolved compiler configuration is unoptimized depends on
  // effective target settings, not merely the configuration's name.
  if (finalSettings.IS_UNOPTIMIZED_BUILD === undefined) {
    finalSettings.IS_UNOPTIMIZED_BUILD =
      finalSettings.GCC_OPTIMIZATION_LEVEL === "0" &&
      finalSettings.SWIFT_OPTIMIZATION_LEVEL === "-Onone" ? "YES" : "NO";
  }
  // The project may declare SWIFT_VERSION=5.0 but Xcode reports the
  // effective language mode as "5". Explicit effective settings still win.
  if (accumulator.EFFECTIVE_SWIFT_VERSION === "$(SWIFT_VERSION)") {
    const version = String(finalSettings.SWIFT_VERSION ?? "");
    finalSettings.EFFECTIVE_SWIFT_VERSION = /^\d+\.0$/.test(version)
      ? version.slice(0, -2) : version;
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
