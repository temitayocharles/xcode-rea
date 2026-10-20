import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSettingsReport } from "../src/compat/settings-summary.js";

test("settings summary groups all differences while redacting values and paths", () => {
  const report = {
    gates: [{
      name: "settings: resolved build settings",
      differing: 3,
      unimplemented: 2,
      differences: [
        { target: "HelloXcode", key: "ARCHS", kind: "different", xcl: "arm64", xcodebuild: "arm64 x86_64" },
        { target: "HelloXcodeTests", key: "ARCHS", kind: "different", xcl: "arm64", xcodebuild: "arm64 x86_64" },
        { target: "HelloXcode", key: "CODE_SIGNING_ALLOWED", kind: "different", xcl: "NO", xcodebuild: "YES" },
        { target: "HelloXcode", key: "CACHE_ROOT", kind: "missing" },
        { target: "HelloXcodeTests", key: "CACHE_ROOT", kind: "missing" },
      ],
    }],
  };
  const summary = summarizeSettingsReport(report, { limit: 3 });
  assert.match(summary, /Reported: 3 value mismatches, 2 missing settings/);
  assert.match(summary, /ARCHS \(x2\)/);
  assert.match(summary, /CACHE_ROOT \(x2\)/);
  assert.match(summary, /Signing: 1 occurrences \/ 1 unique keys/);
  assert.doesNotMatch(summary, /arm64|x86_64|CODE_SIGNING_ALLOWED.*NO|xcodebuild=/);
});

test("summarizer rejects truncated legacy reports and impossible limits", () => {
  const old = { gates: [{ name: "settings: resolved build settings", lines: [] }] };
  assert.throws(() => summarizeSettingsReport(old), /complete settings differences/);
  assert.throws(() => summarizeSettingsReport({ gates: [] }, { limit: 0 }), /limit must be/);
});
