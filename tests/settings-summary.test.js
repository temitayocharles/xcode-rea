import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSettingsReport, summarizeValueDifferences, summarizeMissingReferenceValues, redactSettingValue, redactedXcodeCachePathKind, summarizeOpaqueMissingFields } from "../src/compat/settings-summary.js";

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
  assert.doesNotMatch(result, /DEVELOPMENT_TEAM|SECRET|Users\/private|__INTERNAL|WORKSPACE_DIR = \/Users/);
  assert.throws(() => summarizeMissingReferenceValues(report, { limit: 0 }), /limit/);
});

test("dynamic Xcode path categories do not disclose users or SDK stat-cache digests", () => {
  const sdk = "/Users/private/Library/Developer/Xcode/DerivedData/SDKStatCaches.noindex/iphonesimulator27.1-26A1-1234567890abcdef.sdkstatcache";
  assert.equal(redactedXcodeCachePathKind(sdk),
    "<derived-data>/SDKStatCaches.noindex/<SDK-specific-digest>.sdkstatcache");
  assert.equal(redactedXcodeCachePathKind("/Users/private/Library/Developer/Xcode/DerivedData"),
    "<Xcode DerivedData root>");
  assert.equal(redactedXcodeCachePathKind("/var/private/C/CompilationCache.noindex"),
    "<derived-data-or-cache>/CompilationCache.noindex");
  assert.equal(redactedXcodeCachePathKind("/Users/private/apps/HelloXcode.xcodeproj"),
    "<project>.xcodeproj");
  assert.equal(redactedXcodeCachePathKind("/Users/private/apps/App.xcworkspace"),
    "<workspace>.xcworkspace");
  assert.equal(redactedXcodeCachePathKind("relative/path"), "<missing-or-nonabsolute>");
  const report = { gates: [{
    name: "settings: resolved build settings",
    differences: [
      { target: "App", kind: "missing", key: "PROVISIONING_PROFILE_SUPPORTED", xcodebuild: "YES" },
      { target: "App", kind: "missing", key: "ENTITLEMENTS_ALLOWED", xcodebuild: "NO" },
      { target: "App", kind: "missing", key: "SDK_STAT_CACHE_PATH", xcodebuild: sdk },
      { target: "App", kind: "missing", key: "SDK_STAT_CACHE_DIR",
        xcodebuild: "/Users/private/Library/Developer/Xcode/DerivedData" },
      { target: "App", kind: "missing", key: "PATH", xcodebuild: "/Users/private/bin:/usr/bin" },
    ],
  }] };
  const output = summarizeMissingReferenceValues(report);
  assert.match(output, /PROVISIONING_PROFILE_SUPPORTED = "YES"/);
  assert.match(output, /ENTITLEMENTS_ALLOWED = "NO"/);
  assert.match(output, /SDK_STAT_CACHE_PATH = <derived-data>\/SDKStatCaches/);
  assert.doesNotMatch(output, /Users\/private|1234567890abcdef|\n  PATH =/);
});

test("remaining product linker selectors show reference values with path masking", () => {
  const report = { gates: [{
    name: "settings: resolved build settings",
    differences: [
      { kind: "missing", target: "HelloXcodeTests",
        key: "LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO",
        xcodebuild: "@loader_path/Frameworks" },
      { kind: "missing", target: "HelloXcode",
        key: "PRODUCT_SPECIFIC_LDFLAGS",
        xcodebuild: "-L /Users/private/build/lib -framework XCTest" },
      { kind: "missing", target: "HelloXcode", key: "PATH",
        xcodebuild: "/Users/private/bin:/usr/bin" },
    ],
  }] };
  const output = summarizeMissingReferenceValues(report);
  assert.match(output, /HelloXcodeTests.LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO/);
  assert.match(output, /HelloXcode.PRODUCT_SPECIFIC_LDFLAGS/);
  assert.match(output, /-framework XCTest/);
  assert.doesNotMatch(output, /Users\/private|\/Users\/private\/bin/);
  assert.doesNotMatch(output, /HelloXcode.PATH/);
});

test("runtime cache directory and generated entry classifications hide local names", () => {
  const paths = [
    ["/Users/sensitive/Library/Developer/Xcode/DerivedData/SDKStatCaches.noindex",
      "<cache-root>/SDKStatCaches.noindex"],
    ["/Users/sensitive/Library/Developer/Xcode/DerivedData/SDKStatCaches.noindex/opaque-cache-record",
      "<cache-root>/SDKStatCaches.noindex/<opaque-entry>"],
    ["/Users/sensitive/Library/Developer/Xcode/DerivedData/Build/Intermediates.noindex/Secret.build/Debug-iphonesimulator/Test.build/DerivedSources/TestEntry.swift",
      "<derived-data>/Build/Intermediates.noindex/<project>/<configuration>/<target>/DerivedSources/<generated-entry>"],
  ];
  for (const [absolute, expected] of paths) {
    assert.equal(redactedXcodeCachePathKind(absolute), expected);
    assert.doesNotMatch(redactedXcodeCachePathKind(absolute), /sensitive|Secret|TestEntry/);
  }
});

test("SDK stat cache digest and Xcode PATH diagnostics disclose structural classes only", () => {
  const report = { gates: [{ name: "settings: resolved build settings", differences: [
    { kind: "missing", target: "HelloXcode", key: "SDK_STAT_CACHE_PATH",
      xcodebuild: "/Users/private/SDKStatCaches.noindex/iphonesimulator27.1-26A987-abcdef0123456789abcdef0123456789.sdkstatcache" },
    { kind: "missing", target: "HelloXcode", key: "PATH",
      xcodebuild: "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin:/Applications/Xcode.app/Contents/Developer/usr/bin:/Users/private/local/bin:/usr/bin:/bin" },
  ] }] };
  const output = summarizeOpaqueMissingFields(report);
  assert.match(output, /SDK_STAT_CACHE_PATH: sdk-family=iphonesimulator, sdk-version=27.1, sdk-build=26A987, digest-hex-length=32/);
  assert.match(output, /PATH: entries=5, classes=xcode-toolchain-bin,xcode-developer-bin,other,system-bin,system-bin/);
  assert.doesNotMatch(output, /Users\/private|abcdef0123456789|XcodeDefault.xctoolchain|local\/bin/);
});

test("opaque missing-field evidence only prints public structural shapes", () => {
  const report = { gates: [{ name: "settings: resolved build settings", differences: [
    { kind: "missing", key: "__ARCHS__", xcodebuild: "arm64 x86_64" },
    { kind: "missing", key: "AGGREGATE_TRACKED_DOMAINS", xcodebuild: "YES" },
    { kind: "missing", key: "SDK_STAT_CACHE_DIR", xcodebuild: "/Users/private/Library/Developer/Xcode/DerivedData/secret" },
    { kind: "missing", key: "_BUILDABLE_SERIALIZATION_KEY", xcodebuild: "SecretOpaqueKey2026" },
    { kind: "missing", key: "GENERATED_TEST_ENTRY_POINT_PATH", xcodebuild: "/Users/private/DerivedSources/privateTester.swift" },
    { kind: "missing", key: "SWIFT_EMIT_CONST_VALUE_PROTOCOLS", xcodebuild: "AppEntity AppIntent AppEnum" },
  ] }] };
  const output = summarizeOpaqueMissingFields(report);
  assert.match(output, /architecture-list: arm64 x86_64/);
  assert.match(output, /protocol-count=3, unique=3/);
  assert.match(output, /public-components=Library\/Developer\/Xcode\/DerivedData/);
  assert.doesNotMatch(output, /Users\/private|SecretOpaqueKey2026|privateTester/);
});
