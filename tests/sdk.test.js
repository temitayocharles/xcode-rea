import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSdks, resolveSdk, sdkDisplayName } from "../src/settings/toolchain.js";

test("SDK canonical names with embedded version are not double-suffixed", () => {
  assert.equal(sdkDisplayName("iphonesimulator27.1", "27.1"), "iphonesimulator27.1");
  assert.equal(sdkDisplayName("iphonesimulator", "27.1"), "iphonesimulator27.1");
  assert.equal(sdkDisplayName("macosx27.0", "27.0"), "macosx27.0");
  assert.equal(sdkDisplayName("iphonesimulator", ""), "iphonesimulator");
});

test("SDK discovery reads installed SDK settings and normalizes versioned names", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-discovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sdkPath = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer",
    "SDKs", "iPhoneSimulator27.1.sdk");
  mkdirSync(sdkPath, { recursive: true });
  writeFileSync(join(sdkPath, "SDKSettings.plist"), `<?xml version="1.0" encoding="UTF-8"?>
  <plist version="1.0"><dict>
    <key>CanonicalName</key><string>iphonesimulator27.1</string>
    <key>Version</key><string>27.1</string>
    <key>DefaultProperties</key><dict>
      <key>IPHONEOS_DEPLOYMENT_TARGET</key><string>17.0</string>
    </dict>
  </dict></plist>`);
  const sdk = resolveSdk({ developerDir: directory, platform: "iphonesimulator",
    requested: "iphonesimulator" });
  // On macOS, tmpdir() may return /var while realpathSync resolves /private/var.
  // Compare actual canonical paths, not the textual spelling of a symlink.
  assert.equal(sdk.path, realpathSync(sdkPath));
  assert.equal(sdk.name, "iphonesimulator27.1");
  assert.equal(sdk.version, "27.1");
  assert.equal(sdk.defaultProperties.IPHONEOS_DEPLOYMENT_TARGET, "17.0");
  assert.equal(listSdks({ developerDir: directory, platform: "iphonesimulator" })[0].name,
    "iphonesimulator27.1");
});

test("SDK alias paths resolve to the concrete installed version", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs");
  const canonical = join(root, "iPhoneSimulator27.1.sdk");
  const alias = join(root, "iPhoneSimulator.sdk");
  mkdirSync(canonical, { recursive: true });
  symlinkSync(canonical, alias);
  writeFileSync(join(canonical, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator27.1</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  const sdk = resolveSdk({ developerDir: directory, platform: "iphonesimulator",
    requested: "iphonesimulator" });
  assert.equal(sdk.path, realpathSync(canonical));
  const explicit = resolveSdk({ developerDir: directory, platform: "iphonesimulator",
    requested: alias });
  assert.equal(explicit.path, realpathSync(canonical));
});
