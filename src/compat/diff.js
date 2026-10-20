/**
 * Pure comparison helpers used by the macOS differential gate.
 *
 * Keeping them free of child processes and platform checks means the actual
 * diff rules are unit-testable on any host, while `scripts/macos-verify.mjs`
 * only supplies the data.
 */

const DEFAULT_IGNORED = new Set([
  // Build directories legitimately differ when DerivedData paths differ.
  "BUILD_DIR",
  "BUILD_ROOT",
  "CONFIGURATION_BUILD_DIR",
  "CONFIGURATION_TEMP_DIR",
  "OBJROOT",
  "SYMROOT",
  "PROJECT_TEMP_DIR",
  "SHARED_PRECOMPS_DIR",
  // Version stamps follow the installed toolchain; the build gate reports it.
  "XCODE_VERSION_ACTUAL",
  "XCODE_VERSION_MINOR",
  "XCODE_BUILD",
  "XCODE_PRODUCT_BUILD_VERSION",
  // Process environment leaked into the build environment.
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "_",
  "OLDPWD",
  "PWD",
  "SHLVL",
]);

export function ignoredKeys(extra = []) {
  return new Set([...DEFAULT_IGNORED, ...extra]);
}

const LIST_KEYS = ["targets", "configurations", "schemes"];

/**
 * Compare `xcodebuild -list -json` with `xcl -list --json`.
 * Both use `{ project: { targets, configurations, schemes } }`.
 */
export function diffList(reference, actual) {
  const differences = [];
  for (const key of LIST_KEYS) {
    const expected = [...(reference?.[key] ?? [])].sort();
    const received = [...(actual?.[key] ?? [])].sort();
    const missing = expected.filter((entry) => !received.includes(entry));
    const extra = received.filter((entry) => !expected.includes(entry));
    if (missing.length > 0) differences.push(`${key}: missing ${missing.join(", ")}`);
    if (extra.length > 0) differences.push(`${key}: extra ${extra.join(", ")}`);
  }
  return { ok: differences.length === 0, differences };
}

/**
 * Compare resolved build settings, target by target.
 *
 * @param {Map<string, Record<string,string>>} reference values from xcodebuild
 * @param {Map<string, Record<string,string>>} actual values from xcl
 * @param {Set<string>} options.ignore settings whose differences are expected
 * @param {number} options.limit maximum differing values to report
 */
export function compareSettings(reference, actual, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORED;
  const limit = options.limit ?? 25;

  const missingTargets = [...reference.keys()].filter((name) => !actual.has(name));
  const lines = [];
  let compared = 0;
  let unimplemented = 0;
  let differing = 0;

  for (const [target, expected] of reference) {
    const received = actual.get(target) ?? {};
    for (const [key, value] of Object.entries(expected)) {
      // Ignored keys are excluded whether their values differ OR xcl does not
      // implement them. Otherwise a deliberate ignore still fails as missing.
      if (ignore.has(key)) continue;
      compared += 1;
      if (!(key in received)) {
        unimplemented += 1;
        if (unimplemented <= limit) lines.push(`${target}: missing setting ${key}`);
        continue;
      }
      if (String(received[key]) !== String(value)) {
        differing += 1;
        if (differing <= limit) {
          lines.push(
            `${target}: ${key} xcl=${JSON.stringify(received[key])} xcodebuild=${JSON.stringify(value)}`,
          );
        }
      }
    }
  }

  const coverage = compared === 0 ? 0 : ((compared - unimplemented) / compared) * 100;
  return {
    ok: missingTargets.length === 0 && differing === 0 && unimplemented === 0,
    missingTargets,
    compared,
    unimplemented,
    differing,
    coverage,
    lines,
  };
}
