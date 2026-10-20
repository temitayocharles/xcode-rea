import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { assertVerificationRoot, referenceSettingsArgs } from "../src/compat/verification.js";

test("macOS settings comparison selects a target without mixing it with a scheme", () => {
  const options = {
    project: "/work/Hello.xcodeproj",
    scheme: "Hello",
    configuration: "Debug",
    sdk: "iphonesimulator",
  };
  const args = referenceSettingsArgs(options, "Hello");
  assert.deepEqual(args, [
    "-project", "/work/Hello.xcodeproj",
    "-target", "Hello",
    "-configuration", "Debug",
    "-sdk", "iphonesimulator",
    "-showBuildSettings", "-json",
  ]);
  assert.ok(!args.includes("-scheme"));
  assert.throws(() => referenceSettingsArgs(options, ""), /project and target are required/);
});

test("macOS verification uses disposable output roots and refuses dangerous paths", () => {
  const repo = resolve("/workspace/xcode-rea");
  const project = resolve("/workspace/xcode-rea/tests/fixtures/Hello/Hello.xcodeproj");
  assert.equal(
    assertVerificationRoot("/workspace/xcode-rea/.verify-derived-data", repo, project),
    resolve("/workspace/xcode-rea/.verify-derived-data"),
  );
  assert.equal(
    assertVerificationRoot("/tmp/xcl-verify-abc", repo, project),
    resolve("/tmp/xcl-verify-abc"),
  );
  assert.throws(() => assertVerificationRoot("/workspace", repo, project), /must be named/);
  assert.throws(() => assertVerificationRoot("/tmp/data", repo, project), /must be named/);
  assert.throws(
    () => assertVerificationRoot("/workspace/.verify-derived-data", "/workspace/.verify-derived-data/repo", project),
    /may not contain/,
  );
});
