import test from "node:test";
import assert from "node:assert/strict";
import { compareSettings, diffList, ignoredKeys } from "../src/compat/diff.js";

const map = (object) => new Map(Object.entries(object));

test("identical project structure produces no differences", () => {
  const reference = {
    targets: ["App", "AppTests"],
    configurations: ["Debug", "Release"],
    schemes: ["App"],
  };
  const result = diffList(reference, { ...reference, targets: [...reference.targets].reverse() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.differences, []);
});

test("missing and extra entries are both reported", () => {
  const result = diffList(
    { targets: ["App", "AppTests"], configurations: ["Debug"], schemes: ["App"] },
    { targets: ["App", "Extra"], configurations: ["Debug"], schemes: [] },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [
    "targets: missing AppTests",
    "targets: extra Extra",
    "schemes: missing App",
  ]);
});

test("matching settings pass", () => {
  const reference = map({ App: { PRODUCT_NAME: "App", SWIFT_VERSION: "5.0", SDKROOT: "iphoneos" } });
  const result = compareSettings(reference, map({ App: { PRODUCT_NAME: "App", SWIFT_VERSION: "5.0", SDKROOT: "iphoneos" } }));
  assert.equal(result.ok, true);
  assert.equal(result.compared, 3);
  assert.equal(result.coverage, 100);
});

test("value mismatches are reported with both values", () => {
  const reference = map({ App: { SWIFT_VERSION: "5.0", PRODUCT_NAME: "App" } });
  const result = compareSettings(reference, map({ App: { SWIFT_VERSION: "4.2", PRODUCT_NAME: "App" } }));
  assert.equal(result.ok, false);
  assert.equal(result.differing, 1);
  assert.deepEqual(result.lines, ['App: SWIFT_VERSION xcl="4.2" xcodebuild="5.0"']);
});

test("ignored keys do not count as mismatches", () => {
  const reference = map({ App: { OBJROOT: "/xcode/obj", PRODUCT_NAME: "App" } });
  const result = compareSettings(reference, map({ App: { OBJROOT: "/xcl/obj", PRODUCT_NAME: "App" } }));
  assert.equal(result.ok, true);
  assert.equal(result.differing, 0);
});

test("settings that xcl does not implement are counted, not ignored", () => {
  const reference = map({ App: { PRODUCT_NAME: "App", FUTURE_SETTING: "1" } });
  const result = compareSettings(reference, map({ App: { PRODUCT_NAME: "App" } }));
  assert.equal(result.ok, false);
  assert.equal(result.unimplemented, 1);
  assert.equal(result.coverage, 50);
  assert.deepEqual(result.lines, ["App: missing setting FUTURE_SETTING"]);
});

test("missing targets are reported separately from missing settings", () => {
  const result = compareSettings(
    map({ App: { A: "1" }, AppTests: { A: "1" } }),
    map({ App: { A: "1" } }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingTargets, ["AppTests"]);
});

test("report length is bounded by the limit", () => {
  const reference = map({ App: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`KEY_${index}`, "1"])) });
  const result = compareSettings(reference, map({ App: {} }), { limit: 5 });
  assert.equal(result.lines.length, 5);
  assert.equal(result.unimplemented, 40);
});

test("extra keys ignored by the caller are accepted", () => {
  const reference = map({ App: { PRODUCT_NAME: "App" } });
  const actual = map({ App: { PRODUCT_NAME: "App" } });
  const result = compareSettings(reference, actual, { ignore: ignoredKeys(["PRODUCT_NAME"]) });
  assert.equal(result.differing, 0);
});
