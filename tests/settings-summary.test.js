import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSettingsReport, summarizeValueDifferences, summarizeMissingReferenceValues, redactSettingValue } from "../src/compat/settings-summary.js";

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

test("value diagnosis keeps comparison shape while masking absolute paths and opaque identifiers", () => {
  const report = {
    gates: [{
      name: "settings: resolved build settings",
      differences: [
        { target: "App", key: "DEVELOPER_FRAMEWORKS_DIR_QUOTED", kind: "different",
          xcl: '"/Users/account/Developer/Library/Frameworks"',
          xcodebuild: "/Users/account/Developer/Library/Frameworks" },
        { target: "App", key: "ARCHS", kind: "different",
          xcl: "arm64", xcodebuild: "arm64 x86_64" },
        { target: "App", key: "PROJECT_GUID", kind: "different",
          xcl: "123456789012345678901234", xcodebuild: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      ],
    }],
  };
  const output = summarizeValueDifferences(report);
  assert.match(output, /App.ARCHS/);
  assert.match(output, /arm64 x86_64/);
  assert.match(output, /absolute:Library\/Frameworks/);
  assert.match(output, /opaque-id/);
  assert.doesNotMatch(output, /Users\/account/);
  const device = redactSettingValue("  /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/Frameworks");
  const simulator = redactSettingValue("  /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks");
  assert.match(device, /platform:iPhoneOS.platform;absolute:Library\/Frameworks/);
  assert.match(simulator, /platform:iPhoneSimulator.platform;absolute:Library\/Frameworks/);
  assert.notEqual(device, simulator);
  assert.doesNotMatch(simulator, /Applications\/Xcode/);
  assert.doesNotMatch(output, /123456789012345678901234/);
  assert.ok(redactSettingValue("") === "<empty>");
  assert.throws(() => summarizeValueDifferences(report, { limit: 0 }), /limit must/);
});

test("redacted Xcode framework paths identify SDK versus platform without private roots", () => {
  const root = "/Users/private/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform";
  const platform = redactSettingValue(root + "/Developer/Library/Frameworks");
  const sdk = redactSettingValue(root + "/Developer/SDKs/iPhoneSimulator27.1.sdk/Developer/Library/Frameworks");
  assert.match(platform, /relative:Developer\/Library\/Frameworks/);
  assert.match(sdk, /relative:Developer\/SDKs\/iPhoneSimulator27.1.sdk\/Developer\/Library\/Frameworks/);
  assert.notEqual(platform, sdk);
  assert.doesNotMatch(sdk, /Users\/private/);
});

test("missing-reference diagnostics show only whitelisted non-private setting values", () => {
  const report = { gates: [{
    name: "settings: resolved build settings",
    differences: [
      { target: "App", key: "NATIVE_ARCH_32_BIT", kind: "missing", xcodebuild: "arm" },
      { target: "Tests", key: "NATIVE_ARCH_32_BIT", kind: "missing", xcodebuild: "arm" },
      { target: "App", key: "MACOSX_DEPLOYMENT_TARGET", kind: "missing", xcodebuild: "27.0" },
      { target: "App", key: "DEVELOPMENT_TEAM", kind: "missing", xcodebuild: "SECRET" },
      { target: "App", key: "WORKSPACE_DIR", kind: "missing", xcodebuild: "/Users/private/projects" },
      { target: "App", key: "__INTERNAL", kind: "missing", xcodebuild: "sensitive" },
    ],
  }] };
  const result = summarizeMissingReferenceValues(report);
  assert.match(result, /NATIVE_ARCH_32_BIT = "arm"/);
  assert.match(result, /MACOSX_DEPLOYMENT_TARGET = "27.0"/);
  assert.equal(result.split("NATIVE_ARCH_32_BIT").length - 1, 1);
  assert.doesNotMatch(result, /DEVELOPMENT_TEAM|SECRET|WORKSPACE_DIR|Users\/private|__INTERNAL/);
  assert.throws(() => summarizeMissingReferenceValues(report, { limit: 0 }), /limit/);
});
