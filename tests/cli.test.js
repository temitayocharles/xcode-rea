import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "bin/xcl.mjs");
const hello = join(root, "tests/fixtures/HelloXcode/HelloXcode.xcodeproj");
const modern = join(root, "tests/fixtures/ModernSync/ModernSync.xcodeproj");
const configChains = join(root, "tests/fixtures/ConfigChains/ConfigChains.xcodeproj");

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

test("xcl -list --json matches the xcodebuild shape", () => {
  const output = JSON.parse(run(["-project", hello, "-list", "--json"]));
  assert.equal(output.project.name, "HelloXcode");
  assert.deepEqual(output.project.targets, ["HelloXcode", "HelloXcodeTests"]);
  assert.deepEqual(output.project.configurations, ["Debug", "Release"]);
  assert.deepEqual(output.project.schemes, ["HelloXcode"]);
});

test("xcl xcodebuild -list works as a drop-in alias", () => {
  const output = run(["xcodebuild", "-project", hello, "-list"]);
  assert.match(output, /Information about project "HelloXcode"/);
});

test("xcl -showBuildSettings --json resolves settings", () => {
  const output = JSON.parse(
    run([
      "-project",
      hello,
      "-target",
      "HelloXcode",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-arch",
      "arm64",
      "-showBuildSettings",
      "--json",
    ]),
  );
  assert.equal(output.length, 1);
  assert.equal(output[0].action, "build");
  assert.equal(output[0].target, "HelloXcode");
  assert.equal(output[0].buildSettings.PRODUCT_NAME, "HelloXcode");
  assert.equal(output[0].buildSettings.ARCHS, "arm64");
  assert.equal(output[0].buildSettings.SWIFT_OPTIMIZATION_LEVEL, "-Onone");
});

test("xcl build --dry-run prints a real plan without executing", () => {
  const output = run([
    "-project",
    hello,
    "-scheme",
    "HelloXcode",
    "-configuration",
    "Debug",
    "-sdk",
    "iphonesimulator",
    "-arch",
    "arm64",
    "--dry-run",
  ]);
  assert.match(output, /xcrun swiftc/);
  assert.match(output, /actool/);
  assert.match(output, /generate-info-plist/);
  assert.match(output, /codesign/);
  assert.match(output, /DRY RUN COMPLETE/);
});

test("xcl build --dry-run works for synchronized projects", () => {
  const output = run([
    "-project",
    modern,
    "-scheme",
    "ModernSync",
    "-configuration",
    "Debug",
    "-sdk",
    "iphonesimulator",
    "-arch",
    "arm64",
    "--dry-run",
  ]);
  assert.match(output, /Sub\/Helper.swift/);
  assert.doesNotMatch(output, /DevOnly\.swift/);
  assert.match(output, /Copy Notes\.md/);
});

test("xcl -workspace resolves projects and schemes", () => {
  const output = JSON.parse(
    run([
      "-workspace",
      join(root, "tests/fixtures/HelloXcode/HelloXcode.xcworkspace"),
      "-list",
      "--json",
    ]),
  );
  assert.equal(output.workspace.name, "HelloXcode");
  assert.equal(output.project.name, "HelloXcode");
});

test("xcl doctor reports a usable state", () => {
  const output = run(["doctor"]);
  assert.match(output, /^xcl \d+\.\d+\.\d+/);
  assert.match(output, /Node\.js/);
});

test("xcl rea plan writes a runnable evidence plan", () => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-rea-"));
  const output = run(["rea", "plan", "--out", directory, "--xcode", "/Applications/Xcode.app"]);
  assert.match(output, /REA evidence plan/);
  assert.ok(existsSync(join(directory, "plan.json")));
  assert.ok(existsSync(join(directory, "collect.sh")));
  const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  assert.ok(plan.commands.length >= 10);
  assert.ok(plan.commands.every((entry) => entry.command.startsWith("rea ")));
  const script = readFileSync(join(directory, "collect.sh"), "utf8");
  assert.match(script, /rea inspect-artifact/);
  assert.match(script, /XCODE=/);
});

test("xcl rea import extracts candidate settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-import-"));
  const input = join(directory, "evidence.json");
  const output = join(directory, "evidence-out.json");
  execFileSync(
    "node",
    [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(input)}, JSON.stringify({
        strings: ["PRODUCT_BUNDLE_IDENTIFIER", "SWIFT_VERSION", "OTHER_LDFLAGS", "YES"],
        framework: "/System/Library/Frameworks/UIKit.framework/UIKit",
        library: "/usr/lib/libz.tbd"
      }))`,
    ],
    { cwd: root },
  );
  const log = run(["rea", "import", input, "--out", output]);
  assert.match(log, /build-setting candidates/);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(evidence.buildSettings.PRODUCT_BUNDLE_IDENTIFIER.observations, 1);
  assert.ok(!evidence.buildSettings.YES);
  assert.ok(evidence.frameworks.includes("UIKit"));
  assert.ok(evidence.libraries.includes("libz"));
});

test("xcl compat report explains the evidence workflow", () => {
  const output = run(["compat", "report", "--out", join(tmpdir(), "missing-evidence.json")]);
  assert.match(output, /No REA evidence imported yet/);
  assert.match(output, /xcl rea plan/);
});

test("xcl version prints the CLI version", () => {
  const output = run(["version"]);
  assert.match(output, /^xcl \d+\.\d+\.\d+/);
});

test("xcl -showdestinations resolves to the destinations command", () => {
  const text = run(["-showdestinations"]);
  assert.match(text, /Available destinations/);
  const json = JSON.parse(run(["-showdestinations", "--json"]));
  assert.ok(Array.isArray(json.destinations));
});

test("-showBuildSettings reports a product bundle package type", () => {
  const output = JSON.parse(
    run(["-project", hello, "-target", "HelloXcode", "-sdk", "iphonesimulator", "-showBuildSettings", "--json"]),
  );
  const settings = output[0].buildSettings;
  assert.equal(settings.PRODUCT_BUNDLE_PACKAGE_TYPE, "APPL");
  assert.equal(settings.WRAPPER_NAME, "HelloXcode.app");
});

test("clean removes only the selected target product", () => {
  const derived = mkdtempSync(join(tmpdir(), "xcl-clean-"));
  const products = join(derived, "Build/Products/Release-iphonesimulator");
  mkdirSync(join(products, "HelloXcode.app"), { recursive: true });
  writeFileSync(join(products, "HelloXcode.app/HelloXcode"), "");
  mkdirSync(join(products, "Other.app"), { recursive: true });

  run([
    "-project",
    hello,
    "-target",
    "HelloXcode",
    "-sdk",
    "iphonesimulator",
    "-derivedDataPath",
    derived,
    "clean",
  ]);

  assert.equal(existsSync(join(products, "HelloXcode.app")), false);
  assert.equal(existsSync(join(products, "Other.app")), true);
});

test("unknown configurations and targets fail with a usage error", () => {
  assert.throws(
    () => run(["-project", hello, "-configuration", "Nope", "-showBuildSettings"]),
    (error) => error.status === 2 && /configuration "Nope" not found/.test(error.stderr),
  );
  assert.throws(
    () => run(["-project", hello, "-target", "Nope", "-showBuildSettings"]),
    (error) => error.status === 2 && /target "Nope" not found/.test(error.stderr),
  );
});
