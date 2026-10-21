import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPlatformProperties, platformDefaults } from "../src/settings/defaults.js";

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
  assert.equal(defaults.PLATFORM_USES_DSYMS, "YES");
  assert.equal(defaults.SDK_PRODUCT_BUILD_VERSION, "24F123");
  assert.equal(defaults.PLATFORM_PRODUCT_BUILD_VERSION, "27A9275");
});

test("unknown or incomplete platform metadata never fabricates a build version", () => {
  assert.deepEqual(installedPlatformProperties("/tmp/xcl-metadata-does-not-exist", "iphonesimulator"), {});
  assert.deepEqual(installedPlatformProperties(null, "iphoneos"), {});
});
