/**
 * Summarize differential evidence without printing environment-specific paths,
 * usernames, signing identities or raw build-setting values.
 */
const CATEGORIES = [
  ["Architecture and platform", /^(?:ARCH|VALID_ARCH|CURRENT_ARCH|NATIVE_ARCH|SDK|PLATFORM|SUPPORTED_PLATFORMS|EFFECTIVE_PLATFORM|DEPLOYMENT|IPHONEOS|MACOSX|TARGETED_DEVICE_FAMILY|SWIFT_PLATFORM)/],
  ["Signing", /(?:CODE_SIGN|PROVISIONING|DEVELOPMENT_TEAM|ENTITLEMENT|CODESIGN)/],
  ["Build paths and products", /(?:DIR|PATH|ROOT|FOLDER|WRAPPER|PRODUCT|EXECUTABLE|INFOPLIST|BUNDLE|MODULE_CACHE)/],
  ["Compiler and linker", /^(?:SWIFT|CLANG|GCC|LD_|OTHER_LD|OTHER_SWIFT|OTHER_CFLAGS|MTL_|COMPILER|ENABLE_)/],
  ["Xcode internals", /^(?:_|__|CACHE_|BUILD_COMPONENTS|DEFAULT_|AGGREGATE_|CCHROOT|XCODE_)/],
];

export function summarizeSettingsReport(report, { limit = 12 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("limit must be an integer between 1 and 200");
  }
  const gates = report?.gates;
  if (!Array.isArray(gates)) throw new Error("not a macOS verification report");
  const gate = gates.find((item) => item.name === "settings: resolved build settings");
  if (!gate || !Array.isArray(gate.differences)) {
    throw new Error("report lacks complete settings differences; pull the updated branch and rerun --skip-build");
  }
  const data = gate.differences.filter((d) =>
    (d.kind === "different" || d.kind === "missing") &&
    typeof d.key === "string" && /^[A-Za-z0-9_]+$/.test(d.key) &&
    typeof d.target === "string"
  );
  if (data.length !== gate.differences.length) {
    throw new Error("invalid settings difference entry");
  }
  const lines = [
    "Settings comparison (names and counts only; values and paths omitted)",
    `Reported: ${gate.differing ?? "?"} value mismatches, ${gate.unimplemented ?? "?"} missing settings`,
  ];
  const targets = [...new Set(data.map((d) => d.target))].sort();
  for (const target of targets) {
    const rows = data.filter((d) => d.target === target);
    lines.push(`Target ${target}: ${rows.filter((d) => d.kind === "different").length} differing, ${rows.filter((d) => d.kind === "missing").length} missing`);
  }

  for (const kind of ["different", "missing"]) {
    lines.push("");
    lines.push(kind === "different" ? "VALUE MISMATCHES" : "MISSING SETTINGS");
    const counts = new Map();
    for (const row of data.filter((d) => d.kind === kind)) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    }
    const categories = new Map([...CATEGORIES.map(([name]) => [name, []]), ["Other", []]]);
    for (const [key, count] of counts) {
      const category = CATEGORIES.find(([, regex]) => regex.test(key))?.[0] ?? "Other";
      categories.get(category).push({ key, count });
    }
    for (const [category, rows] of categories) {
      if (rows.length === 0) continue;
      rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      const seen = rows.reduce((total, row) => total + row.count, 0);
      lines.push(`  ${category}: ${seen} occurrences / ${rows.length} unique keys`);
      for (const row of rows.slice(0, limit)) {
        lines.push(`    ${row.key} (x${row.count})`);
      }
      if (rows.length > limit) lines.push(`    ... ${rows.length - limit} more unique keys`);
    }
  }
  return lines.join("\n");
}

/**
 * Diagnostic values are not a shareable substitute for the original report.
 * Print only structure: leave ordinary compiler flags legible but mask
 * absolute filesystem tokens and long opaque account/identity identifiers.
 * Detailed unredacted evidence stays in the local JSON report.
 */
export function redactSettingValue(value) {
  if (value === undefined || value === null) return "<absent>";
  const source = String(value);
  if (source === "") return "<empty>";
  // Redact opaque identifiers while retaining simple compiler flags.
  const opaqueRedacted = source.replace(/\b[A-Fa-f0-9]{24,}\b/g, "<opaque-id>");
  const pathsRedacted = opaqueRedacted.replace(
    /(^|[\s="'])(\/(?:[^\s"'=]+\/?)+)/g,
    (_match, prefix, path) => {
      const components = path.split("/").filter(Boolean);
      // Preserve the public Apple platform bundle name: otherwise device
      // versus simulator SDK frameworks appear identical after redaction.
      const platformMatch = /\/Platforms\/([A-Za-z0-9]+\.platform)\//.exec(path);
      const platformLabel = platformMatch ? `platform:${platformMatch[1]};` : "";
      // Preserve only standard, public Apple toolchain components below the
      // platform bundle. This reveals SDK-vs-platform framework differences
      // without exposing the machine's installation location or username.
      let publicRelative = "";
      if (platformMatch) {
        const tail = path.slice(path.indexOf(platformMatch[0]) + platformMatch[0].length);
        const parts = tail.split("/").filter(Boolean);
        if (parts.length > 0 && parts.length <= 8 &&
            parts.every((part) => /^(?:Developer|SDKs|System|Library|Frameworks|PrivateFrameworks|[A-Za-z0-9.]+\.sdk)$/.test(part))) {
          publicRelative = `;relative:${parts.join("/")}`;
        }
      }
      return prefix + "<" + platformLabel + "absolute:" +
        components.slice(-2).join("/") + publicRelative + ">";
    },
  );
  return pathsRedacted.length <= 220
    ? JSON.stringify(pathsRedacted)
    : JSON.stringify(pathsRedacted.slice(0, 217) + "...");
}

export function summarizeValueDifferences(report, { limit = 45 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("limit must be an integer between 1 and 200");
  }
  const gate = report?.gates?.find((item) => item.name === "settings: resolved build settings");
  if (!Array.isArray(gate?.differences)) {
    throw new Error("report lacks structured differences");
  }
  const rows = gate.differences.filter((entry) => entry.kind === "different");
  const output = [
    "VALUE COMPARISON (absolute path prefixes and opaque identifiers masked)",
    "Unredacted values remain only in the local JSON report. Review before sharing.",
  ];
  for (const row of rows.slice(0, limit)) {
    if (!/^[A-Za-z0-9_]+$/.test(row.key ?? "") ||
      !/^[A-Za-z0-9_]+$/.test(row.target ?? "")) {
      throw new Error("invalid difference record");
    }
    output.push(`  ${row.target}.${row.key}`);
    output.push(`    xcl:      ${redactSettingValue(row.xcl)}`);
    output.push(`    Xcode:    ${redactSettingValue(row.xcodebuild)}`);
  }
  if (rows.length > limit) output.push(`  ... ${rows.length - limit} additional differing occurrences in JSON`);
  return output.join("\n");
}

/**
 * Only selected non-identity Xcode build-setting references may appear in the
 * terminal. Internal keys, provisioning identities and token-like values stay
 * in the local JSON report. All absolute paths are still masked.
 */
const DIAGNOSTIC_REFERENCE_KEYS = new Set([
  "ARCHS_STANDARD_32_64_BIT", "ARCHS_UNIVERSAL_IPHONE_OS",
  "MACOSX_DEPLOYMENT_TARGET", "NATIVE_ARCH_32_BIT", "NATIVE_ARCH_64_BIT",
  "PLATFORM_REQUIRES_SWIFT_AUTOLINK_EXTRACT",
  "PLATFORM_REQUIRES_SWIFT_MODULEWRAP", "PLATFORM_USES_DSYMS",
  "COMPILATION_CACHE_KEEP_CAS_DIRECTORY", "SCANNING_PCM_KEEP_CACHE_DIRECTORY",
  "RPATH_ORIGIN", "SWIFT_EMIT_CONST_VALUE_PROTOCOLS", "ENABLE_DEBUG_DYLIB",
  "ANDROID_DEPLOYMENT_TARGET", "DRIVERKIT_DEPLOYMENT_TARGET",
  "DIAGNOSE_MISSING_TARGET_DEPENDENCIES", "LINK_OBJC_RUNTIME",
  "ONLY_ARCH", "RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET",
  "SKIP_COPYING_TEST_FRAMEWORKS", "TVOS_DEPLOYMENT_TARGET",
  "WATCHOS_DEPLOYMENT_TARGET", "XROS_DEPLOYMENT_TARGET",
  "SUPPORTS_ON_DEMAND_RESOURCES", "VALIDATE_DEVELOPMENT_ASSET_PATHS",
  // These are Boolean profile capabilities, never identities or profile IDs.
  "PROVISIONING_PROFILE_REQUIRED", "PROVISIONING_PROFILE_SUPPORTED",
  "PROVISIONING_PROFILE_REQUIRED_YES_YES", "ENTITLEMENTS_ALLOWED",
  // Product-specific linker selectors and their resolved values are needed
  // to implement the Xcode product spec, but may contain local paths. They
  // always pass through redactSettingValue before reaching the terminal.
  "LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO",
  "LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_YES",
  "LD_RUNPATH_SEARCH_PATHS_YES",
  "PRODUCT_SPECIFIC_LDFLAGS",
  "PRODUCT_SPECIFIC_LDFLAGS_NO_XCTEST_NO",
  "PRODUCT_TYPE_SWIFT_STDLIB_TOOL_FLAGS_NO_XCTEST_NO",
]);
/**
 * Report only non-sensitive structural categories for dynamic path defaults.
 * Never print local user directories, filenames, identity digests, or PATH.
 */
export function redactedXcodeCachePathKind(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "<missing-or-nonabsolute>";
  if (/\/SDKStatCaches\.noindex\/[^/]+\.sdkstatcache$/.test(value)) {
    return "<derived-data>/SDKStatCaches.noindex/<SDK-specific-digest>.sdkstatcache";
  }
  if (/\/CompilationCache\.noindex$/.test(value)) {
    return "<derived-data-or-cache>/CompilationCache.noindex";
  }
  if (/\/DerivedData\/?$/.test(value)) {
    return "<Xcode DerivedData root>";
  }
  if (/\/SDKStatCaches\.noindex\/?$/.test(value)) {
    return "<cache-root>/SDKStatCaches.noindex";
  }
  if (/\/SDKStatCaches\.noindex\/[^/]+$/.test(value)) {
    return "<cache-root>/SDKStatCaches.noindex/<opaque-entry>";
  }
  if (/\/Build\/Intermediates\.noindex\/[^/]+\.build\/[^/]+\/[^/]+\.build\/DerivedSources\/[^/]+$/.test(value)) {
    return "<derived-data>/Build/Intermediates.noindex/<project>/<configuration>/<target>/DerivedSources/<generated-entry>";
  }
  if (/\.xcodeproj\/?$/.test(value)) return "<project>.xcodeproj";
  if (/\.xcworkspace\/?$/.test(value)) return "<workspace>.xcworkspace";
  return "<other absolute filesystem path>";
}

/** Privacy-preserving semantic evidence for unresolved Xcode-owned fields. */
export function summarizeOpaqueMissingFields(report) {
  const gate = report?.gates?.find((g) => g.name === "settings: resolved build settings");
  if (!Array.isArray(gate?.differences)) throw new Error("report lacks structured differences");
  const out = ["UNRESOLVED FIELD SHAPES (no private paths or identifiers)"];
  const seen = new Set();
  for (const row of gate.differences) {
    if (row.kind !== "missing" || typeof row.xcodebuild !== "string") continue;
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    const value = row.xcodebuild;
    let label = null;
    if (row.key === "__ARCHS__") {
      // Architecture names are public identifiers. Unknown values remain opaque.
      label = /^(?:arm64|arm64e|x86_64|i386|armv7)(?: (?:arm64|arm64e|x86_64|i386|armv7))*$/.test(value)
        ? `architecture-list: ${value}` : `opaque (length ${value.length})`;
    } else if (row.key === "AGGREGATE_TRACKED_DOMAINS") {
      label = value === "YES" || value === "NO" || value === "" ?
        `boolean-or-empty: ${value || "<empty>"}` : `opaque (length ${value.length})`;
    } else if (row.key === "GENERATED_TEST_ENTRY_POINT_PATH") {
      const filename = value.split("/").pop() ?? "";
      // Reveal only known public SwiftBuild test-entry filenames.
      label = /^(?:__SwiftTestingEntryPoint|TestingEntryPoint|TestEntryPoint|__XCTRunner|__XCTestEntryPoint)\.swift$/.test(filename)
        ? `public-generated-filename: ${filename}` :
          `generated-filename: <redacted> (extension ${/\.swift$/.test(filename) ? ".swift" : "other"})`;
    } else if (row.key === "SDK_STAT_CACHE_DIR") {
      // Directory depth and final system-standard component are safe to show.
      const pieces = value.split("/").filter(Boolean);
      const known = pieces.filter((p) =>
        /^(?:Library|Developer|Xcode|DerivedData|Caches|SDKStatCaches\.noindex|com\.apple\.DeveloperTools)$/.test(p));
      label = `absolute=${value.startsWith("/") ? "yes" : "no"}, depth=${pieces.length}, public-components=${known.join("/") || "<none>"}`;
    } else if (row.key === "_BUILDABLE_SERIALIZATION_KEY") {
      label = `opaque serialization token (length ${value.length})`;
    } else if (row.key === "SWIFT_EMIT_CONST_VALUE_PROTOCOLS") {
      const tokens = value.split(/\s+/).filter(Boolean);
      label = `protocol-count=${tokens.length}, unique=${new Set(tokens).size}, characters=${value.length}`;
    }
    if (label !== null) {
      const target = /^[A-Za-z0-9_]+$/.test(row.target ?? "") ? `${row.target}.` : "";
      out.push(`  ${target}${row.key}: ${label}`);
    }
  }
  return out.join("\n");
}

export function summarizeMissingReferenceValues(report, { limit = 35 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
  const gate = report?.gates?.find((item) => item.name === "settings: resolved build settings");
  if (!Array.isArray(gate?.differences)) throw new Error("report lacks structured differences");
  const seen = new Set();
  const output = ["SELECTED MISSING REFERENCE VALUES (sensitive/internal keys excluded)",
    "Xcode values are diagnostic evidence, NOT substitutes for implementation."];
  for (const d of gate.differences) {
    if (d.kind !== "missing" || !DIAGNOSTIC_REFERENCE_KEYS.has(d.key)) continue;
    if (seen.has(d.key) || typeof d.xcodebuild !== "string") continue;
    seen.add(d.key);
    // Target identity is not private and distinguishes app versus XCTest
    // conditionals when a setting is missing for only one build target.
    const targetLabel = /^[A-Za-z0-9_]+$/.test(d.target ?? "")
      ? `${d.target}.` : "";
    output.push(`  ${targetLabel}${d.key} = ${redactSettingValue(d.xcodebuild)}`);
    if (seen.size >= limit) break;
  }
  const pathKeys = ["SDK_STAT_CACHE_DIR", "SDK_STAT_CACHE_PATH",
    "COMPILATION_CACHE_CAS_PATH", "WORKSPACE_DIR", "GENERATED_TEST_ENTRY_POINT_PATH"];
  const pathRows = gate.differences.filter((row) =>
    row.kind === "missing" && pathKeys.includes(row.key) &&
    typeof row.xcodebuild === "string");
  if (pathRows.length > 0) {
    output.push("SELECTED DYNAMIC PATH SHAPES (no private roots or digests)");
    for (const [key, value] of new Map(pathRows.map((row) =>
      [row.key, redactedXcodeCachePathKind(row.xcodebuild)]))) {
      output.push(`  ${key} = ${value}`);
    }
  }
  return output.join("\n");
}
