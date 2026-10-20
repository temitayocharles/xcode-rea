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
