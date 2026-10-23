import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSdks, resolveSdk, sdkDisplayName, sdkBuildVersion, xcrunSelectedSdkPath } from "../src/settings/toolchain.js";

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


test("versioned physical SDK wins over unversioned sibling with matching metadata", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-physical-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs");
  const versionless = join(root, "iPhoneSimulator.sdk");
  const versioned = join(root, "iPhoneSimulator27.1.sdk");
  const metadata = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CanonicalName</key><string>iphonesimulator27.1</string>
    <key>Version</key><string>27.1</string></dict></plist>`;
  for (const dir of [versionless, versioned]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SDKSettings.plist"), metadata);
  }
  assert.equal(resolveSdk({
    developerDir: directory, platform: "iphonesimulator", requested: "iphonesimulator",
  }).path, realpathSync(versioned));
  assert.equal(resolveSdk({
    developerDir: directory, platform: "iphonesimulator", requested: versionless,
  }).path, realpathSync(versioned));
  assert.ok(listSdks({ developerDir: directory, platform: "iphonesimulator" })
    .every((sdk) => sdk.path === realpathSync(versioned)));
});

test("versionless SDK with different identity is never remapped to another SDK", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs");
  const versionless = join(root, "iPhoneSimulator.sdk");
  const versioned = join(root, "iPhoneSimulator27.1.sdk");
  mkdirSync(versionless, { recursive: true });
  mkdirSync(versioned, { recursive: true });
  writeFileSync(join(versionless, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  writeFileSync(join(versioned, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphoneos</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  assert.equal(resolveSdk({
    developerDir: directory, platform: "iphonesimulator", requested: versionless,
  }).path, realpathSync(versionless));
});

test("SDK build version is read from the installed system image, not invented", (t) => {
  const developerDir = mkdtempSync(join(tmpdir(), "xcl-sdk-build-version-"));
  t.after(() => rmSync(developerDir, { recursive: true, force: true }));
  const sdk = join(developerDir, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs", "iPhoneSimulator27.1.sdk");
  const systemDir = join(sdk, "System", "Library", "CoreServices");
  mkdirSync(systemDir, { recursive: true });
  writeFileSync(join(sdk, "SDKSettings.plist"), `<?xml version="1.0"?>
  <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator27.1</string>
  <key>Version</key><string>27.1</string></dict></plist>`);
  writeFileSync(join(systemDir, "SystemVersion.plist"), `<?xml version="1.0"?>
  <plist version="1.0"><dict><key>ProductBuildVersion</key>
  <string>24B123</string></dict></plist>`);
  const resolved = resolveSdk({ developerDir, platform: "iphonesimulator", requested: "iphonesimulator" });
  assert.equal(resolved.productBuildVersion, "24B123");
  assert.equal(sdkBuildVersion(sdk, { ProductBuildVersion: "override-product" }), "override-product");
  assert.equal(sdkBuildVersion(sdk, null), "24B123");
});

test("on macOS symbolic SDK selects the exact directory spelling returned by xcrun", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-xcrun-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs");
  const versioned = join(root, "iPhoneSimulator27.1.sdk");
  const alias = join(root, "iPhoneSimulator.sdk");
  mkdirSync(versioned, { recursive: true });
  symlinkSync(versioned, alias);
  writeFileSync(join(versioned, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  let invocations = 0;
  const selected = resolveSdk({
    developerDir: directory, platform: "iphonesimulator", requested: "iphonesimulator",
    hostPlatform: "darwin", useXcrun: true,
    runXcrun(cmd, args) {
      invocations += 1;
      assert.equal(cmd, "xcrun");
      assert.deepEqual(args, ["--sdk", "iphonesimulator", "--show-sdk-path"]);
      return alias + "\n";
    },
  });
  assert.equal(invocations, 1);
  assert.equal(selected.path, alias, "preserve Apple-selected path, not realpath alias");
  assert.equal(selected.version, "27.1");
  assert.equal(selected.name, "iphonesimulator27.1");
});

test("Mac tests with synthetic developer directories never call host xcrun", (t) => {
  const developerDir = mkdtempSync(join(tmpdir(), "xcl-sdk-isolated-"));
  t.after(() => rmSync(developerDir, { recursive: true, force: true }));
  const path = join(developerDir, "Platforms", "iPhoneSimulator.platform",
    "Developer", "SDKs", "iPhoneSimulator27.1.sdk");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  const sdk = resolveSdk({
    developerDir, platform: "iphonesimulator", requested: "iphonesimulator",
    hostPlatform: "darwin",
    runXcrun() { throw new Error("must not use real installed xcrun"); },
  });
  assert.equal(sdk.path, realpathSync(path));
});

test("xcrun selection falls back safely if command unavailable or SDK mismatched", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-sdk-xcrun-fallback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "Platforms", "iPhoneSimulator.platform", "Developer", "SDKs");
  const versioned = join(root, "iPhoneSimulator27.1.sdk");
  mkdirSync(versioned, { recursive: true });
  writeFileSync(join(versioned, "SDKSettings.plist"), `<?xml version="1.0"?>
    <plist version="1.0"><dict><key>CanonicalName</key><string>iphonesimulator</string>
    <key>Version</key><string>27.1</string></dict></plist>`);
  const sdk = resolveSdk({
    developerDir: directory, platform: "iphonesimulator", hostPlatform: "darwin",
    runXcrun: () => { throw new Error("tool not installed"); },
  });
  assert.equal(sdk.path, realpathSync(versioned));
  assert.equal(xcrunSelectedSdkPath("iphonesimulator", {
    hostPlatform: "linux",
    run: () => { throw new Error("should not invoke xcrun"); },
  }), null);
});
