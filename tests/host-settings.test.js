import test from "node:test";
import assert from "node:assert/strict";
import { hostAccountSettings, hostXcodeCacheSettings, hostMacOSVersionSettings } from "../src/settings/host.js";

test("host account settings use discovered owner and group, not fixed identities", () => {
  const result = hostAccountSettings({
    platform: "darwin",
    env: { GROUP: "ignored", HOME: "/home/incorrect" },
    getUserInfo: () => ({ username: "test-builder", homedir: "/Users/test-builder" }),
    getGroup: () => "staff-test",
    uid: 501,
    gid: 20,
  });
  assert.deepEqual(result, {
    ALTERNATE_OWNER: "test-builder",
    INSTALL_OWNER: "test-builder",
    USER: "test-builder",
    ALTERNATE_GROUP: "staff-test",
    INSTALL_GROUP: "staff-test",
    GROUP: "staff-test",
    HOME: "/Users/test-builder",
    UID: "501",
    GID: "20",
  });
});
test("missing user metadata does not prevent build settings resolution", () => {
  const settings = hostAccountSettings({
    platform: "linux",
    env: {},
    getUserInfo: () => { throw new Error("missing user database"); },
    uid: null,
    gid: null,
  });
  assert.equal(settings.ALTERNATE_OWNER, undefined);
  assert.equal(settings.UID, undefined);
});

test("Xcode cache settings are derived from Mac user cache and installed Xcode build", () => {
  const root = "/var/folders/ab/cache-id/C/";
  let calls = 0;
  const settings = hostXcodeCacheSettings({
    platform: "darwin", version: "27.1", build: "27A9275",
    run(command, args) {
      calls += 1;
      assert.equal(command, "getconf");
      assert.deepEqual(args, ["DARWIN_USER_CACHE_DIR"]);
      return root + "\n";
    },
  });
  assert.equal(calls, 1);
  assert.equal(settings.CACHE_ROOT,
    "/var/folders/ab/cache-id/C/com.apple.DeveloperTools/27.1-27A9275/Xcode");
  assert.equal(settings.CCHROOT, settings.CACHE_ROOT);
  assert.equal(settings.CLANG_MODULES_BUILD_SESSION_FILE,
    "/var/folders/ab/cache-id/C/org.llvm.clang/ModuleCache.noindex/Session.modulevalidation");
});

test("Xcode cache settings remain absent without valid host evidence", () => {
  assert.deepEqual(hostXcodeCacheSettings({
    platform: "linux", version: "27.1", build: "27A9275",
    run: () => { throw new Error("unexpected"); },
  }), {});
  assert.deepEqual(hostXcodeCacheSettings({
    platform: "darwin", version: null, build: "27A9275",
  }), {});
  assert.deepEqual(hostXcodeCacheSettings({
    platform: "darwin", version: "27.1", build: "27A9275",
    run: () => { throw new Error("getconf unavailable"); },
  }), {});
  assert.deepEqual(hostXcodeCacheSettings({
    platform: "darwin", version: "27.1", build: "27A9275",
    run: () => "/unexpected/location\n",
  }), {});
});

test("host macOS version settings encode product and build versions from sw_vers", () => {
  const data = hostMacOSVersionSettings({
    platform: "darwin",
    run(command, args) {
      assert.equal(command, "sw_vers");
      return args[0] === "-productVersion" ? "27.0.1\n" : "26A123\n";
    },
  });
  assert.deepEqual(data, {
    MAC_OS_X_VERSION_ACTUAL: "270001",
    MAC_OS_X_VERSION_MAJOR: "270000",
    MAC_OS_X_VERSION_MINOR: "0001",
    MAC_OS_X_PRODUCT_BUILD_VERSION: "26A123",
  });
  const historical = hostMacOSVersionSettings({
    platform: "darwin",
    run(command, args) {
      return args[0] === "-productVersion" ? "10.12.6" : "16G29";
    },
  });
  assert.equal(historical.MAC_OS_X_VERSION_ACTUAL, "101206");
  assert.equal(historical.MAC_OS_X_VERSION_MAJOR, "101200");
  assert.equal(historical.MAC_OS_X_VERSION_MINOR, "1206");
});

test("host OS metadata is absent or bounded when sw_vers is unavailable", () => {
  assert.deepEqual(hostMacOSVersionSettings({ platform: "linux" }), {});
  assert.deepEqual(hostMacOSVersionSettings({
    platform: "darwin", run: () => { throw new Error("sw_vers unavailable"); },
  }), {});
  assert.deepEqual(hostMacOSVersionSettings({
    platform: "darwin", run: () => "invalid-string",
  }), {});
  const noBuild = hostMacOSVersionSettings({
    platform: "darwin", run(command, args) {
      if (args[0] === "-buildVersion") throw new Error("missing build version");
      return "15.4";
    },
  });
  assert.equal(noBuild.MAC_OS_X_VERSION_ACTUAL, "150400");
  assert.equal(noBuild.MAC_OS_X_PRODUCT_BUILD_VERSION, undefined);
});
