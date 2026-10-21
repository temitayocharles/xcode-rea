import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPlatformProperties, platformDefaults } from "../src/settings/defaults.js";
import { installedPlatformEnvironment } from "../src/settings/toolchain.js";
import { resolveBuildSettings } from "../src/settings/resolver.js";
import { loadProject } from "../src/xcode/pbxproj.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

test("installed platform metadata supplies defaults and build version without overriding SDK context", (t) => {
  const developerDir = mkdtempSync(join(tmpdir(), "xcl-platform-meta-"));
  t.after(() => rmSync(developerDir, { recursive: true, force: true }));
  const platformDir = join(developerDir, "Platforms", "iPhoneSimulator.platform");
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, "Info.plist"), `<?xml version="1.0"?>
  <plist version="1.0"><dict>
    <key>DefaultProperties</key><dict>
      <key>PLATFORM_USES_DSYMS</key><string>YES</string>
      <key>SDKROOT</key><string>invalid-platform-default</string>
      <key>XCL_PLATFORM_ONLY[arch=arm64]</key><string>ARCH-CONDITIONAL</string>
      <key>COMPLEX</key><dict><key>not</key><string>a setting</string></dict>
    </dict>
  </dict></plist>`);
  writeFileSync(join(platformDir, "version.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>ProductBuildVersion</key>
    <string>27A9275</string></dict></plist>`);

  const props = installedPlatformProperties(developerDir, "iphonesimulator");
  assert.equal(props.PLATFORM_PRODUCT_BUILD_VERSION, "27A9275");
  assert.equal(props.PLATFORM_USES_DSYMS, "YES");
  assert.equal(props["XCL_PLATFORM_ONLY[arch=arm64]"], "ARCH-CONDITIONAL");
  assert.equal(props.COMPLEX, undefined);

  const defaults = platformDefaults({
    developerDir,
    platform: "iphonesimulator",
    hostArch: "arm64",
    sdk: {
      path: "/virtual/SDKs/iPhoneSimulator27.1.sdk",
      name: "iphonesimulator27.1",
      version: "27.1",
      root: "iphonesimulator",
      productBuildVersion: "24F123",
      defaultProperties: {},
      settings: {},
    },
  });
  assert.equal(defaults.SDKROOT, "/virtual/SDKs/iPhoneSimulator27.1.sdk");
  assert.equal(defaults.PLATFORM_USES_DSYMS, undefined);
  assert.equal(defaults.SDK_PRODUCT_BUILD_VERSION, "24F123");

  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const project = loadProject(join(sourceDir, "fixtures", "HelloXcode", "HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const result = resolveBuildSettings({
    project, target, configuration: "Debug", platform: "iphonesimulator",
    arch: "arm64", hostArch: "arm64", sdk: {
      path: "/virtual/SDKs/iPhoneSimulator27.1.sdk",
      name: "iphonesimulator27.1",
      version: "27.1",
      root: "iphonesimulator",
      productBuildVersion: "24F123",
      defaultProperties: {},
    },
    derivedDataPath: "/tmp/xcl-platform-metadata-output", developerDir,
    // Explicit -sdk wins over the fixture project's symbolic SDKROOT=iphoneos.
    overrides: { SDKROOT: "/virtual/SDKs/iPhoneSimulator27.1.sdk" },
  });
  assert.equal(result.settings.PLATFORM_USES_DSYMS, "YES");
  assert.equal(result.settings.PLATFORM_PRODUCT_BUILD_VERSION, "27A9275");
  assert.equal(result.settings.SDKROOT, "/virtual/SDKs/iPhoneSimulator27.1.sdk");
  assert.equal(result.settings.XCL_PLATFORM_ONLY, "ARCH-CONDITIONAL");
  assert.equal(result.settings.COMPLEX, undefined);
  assert.ok(result.layers.some((layer) => layer.name === "xcode-platform-defaults"));
});

test("unknown or incomplete platform metadata never fabricates a build version", () => {
  assert.deepEqual(installedPlatformProperties("/tmp/xcl-metadata-does-not-exist", "iphonesimulator"), {});
  assert.deepEqual(installedPlatformProperties(null, "iphoneos"), {});
});

test("installed simulator platforms derive a device counterpart and SYSROOT from installed SDK metadata", (t) => {
  const developerDir = mkdtempSync(join(tmpdir(), "xcl-platform-counterpart-"));
  t.after(() => rmSync(developerDir, { recursive: true, force: true }));
  const device = join(developerDir, "Platforms", "iPhoneOS.platform");
  const simulator = join(developerDir, "Platforms", "iPhoneSimulator.platform");
  const sdkDir = join(device, "Developer", "SDKs", "iPhoneOS27.1.sdk");
  mkdirSync(sdkDir, { recursive: true });
  mkdirSync(simulator, { recursive: true });
  writeFileSync(join(sdkDir, "SDKSettings.plist"), `<?xml version="1.0"?>
  <plist version="1.0"><dict><key>CanonicalName</key><string>iphoneos</string>
  <key>Version</key><string>27.1</string></dict></plist>`);
  const expectedRoot = "/virtual/SDKs/iPhoneSimulator27.1.sdk";
  const info = installedPlatformEnvironment({
    developerDir, platform: "iphonesimulator", sdk: { path: expectedRoot },
    hostPlatform: "linux",
  });
  assert.equal(info.AVAILABLE_PLATFORMS, "iphoneos iphonesimulator");
  assert.equal(info.SYSROOT, expectedRoot);
  assert.equal(info.CORRESPONDING_DEVICE_PLATFORM_NAME, "iphoneos");
  assert.equal(info.CORRESPONDING_DEVICE_PLATFORM_DIR, device);
  assert.equal(info.CORRESPONDING_DEVICE_SDK_NAME, "iphoneos27.1");
  assert.equal(info.CORRESPONDING_DEVICE_SDK_DIR, realpathSync(sdkDir));
});

test("missing optional paired platforms and SDKs never produce invented paths", (t) => {
  const developerDir = mkdtempSync(join(tmpdir(), "xcl-platform-absence-"));
  t.after(() => rmSync(developerDir, { recursive: true, force: true }));
  const simulator = join(developerDir, "Platforms", "iPhoneSimulator.platform");
  mkdirSync(simulator, { recursive: true });
  let data = installedPlatformEnvironment({
    developerDir, platform: "iphonesimulator", sdk: null, hostPlatform: "linux",
  });
  assert.equal(data.AVAILABLE_PLATFORMS, "iphonesimulator");
  assert.equal(data.CORRESPONDING_DEVICE_SDK_DIR, undefined);
  const device = join(developerDir, "Platforms", "iPhoneOS.platform");
  mkdirSync(device);
  data = installedPlatformEnvironment({
    developerDir, platform: "iphonesimulator", sdk: null, hostPlatform: "linux",
  });
  assert.equal(data.CORRESPONDING_DEVICE_PLATFORM_NAME, "iphoneos");
  assert.equal(data.CORRESPONDING_DEVICE_SDK_NAME, undefined);
});
