import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadProject } from "../src/xcode/pbxproj.js";
import { resolveBuildSettings } from "../src/settings/resolver.js";
import { generatedInfoPlist, planTarget, orderTargets, resolveProjectFile } from "../src/build/plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

function makePlan({ platform = "iphonesimulator", configuration = "Debug", targetName = "HelloXcode", projectPath, arch = "arm64" } = {}) {
  const project = loadProject(projectPath ?? fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName(targetName);
  const sdk = {
    name: `${platform}18.0`,
    version: "18.0",
    path: `/SDK/${platform}.sdk`,
    root: platform,
    defaultProperties: {},
  };
  const { settings } = resolveBuildSettings({
    project,
    target,
    configuration,
    platform,
    sdk,
    arch,
    hostArch: arch,
    derivedDataPath: "/tmp/DerivedData",
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    overrides: { SDKROOT: platform },
  });
  const plan = planTarget({
    project,
    target,
    configuration,
    settings,
    platform,
    arch,
    sdkPath: sdk.path,
    deploymentTarget: settings.DEPLOYMENT_TARGET,
  });
  return { project, target, settings, plan };
}

test("HelloXcode plan contains compile, resources, plist and signing steps", () => {
  const { plan } = makePlan();
  const kinds = plan.steps.map((step) => step.kind);
  assert.ok(kinds.includes("mkdir"));
  assert.ok(kinds.includes("link"));
  assert.equal(kinds.filter((kind) => kind === "resource").length, 2);
  assert.ok(kinds.includes("bundle"));
  assert.ok(kinds.includes("sign"));

  const link = plan.steps.find((step) => step.kind === "link");
  const args = link.command.args;
  assert.equal(link.command.tool, "xcrun");
  assert.equal(args[0], "swiftc");
  assert.ok(args.includes("-module-name"));
  assert.ok(args.includes("HelloXcode"));
  assert.ok(args.includes("arm64-apple-ios17.0-simulator"));
  assert.ok(args.includes("-enable-testing"));
  assert.ok(args.includes("DEBUG"));
  assert.ok(args.includes("-sdk"));
  assert.equal(plan.target.productPath, "/tmp/DerivedData/Build/Products/Debug-iphonesimulator/HelloXcode.app");
});

test("asset catalogs use unique partial Info.plist outputs", () => {
  const { plan } = makePlan();
  const actool = plan.steps.filter((step) => step.display.includes("actool"));
  assert.equal(actool.length, 2);
  const partials = actool.map((step) => step.command.args[step.command.args.indexOf("--output-partial-info-plist") + 1]);
  assert.equal(new Set(partials).size, 2);
});

test("macOS plan places executable and resources in Contents", () => {
  const { plan } = makePlan({ platform: "macosx" });
  const link = plan.steps.find((step) => step.kind === "link");
  assert.ok(link.command.args.includes("/tmp/DerivedData/Build/Products/Debug/HelloXcode.app/Contents/MacOS/HelloXcode"));
  const resources = plan.steps.filter((step) => step.kind === "resource");
  assert.ok(resources.some((step) => step.display.includes("Contents/Resources")));
  const pkginfo = plan.steps.find((step) => step.display.includes("write-pkginfo"));
  assert.ok(pkginfo);
  assert.ok(pkginfo.command.args[1].endsWith("HelloXcode.app/Contents/PkgInfo"));
});

test("Info.plist generation maps INFOPLIST_KEY settings", () => {
  const { settings } = makePlan();
  const info = generatedInfoPlist(settings, { name: "HelloXcode" }, "iphonesimulator");
  assert.equal(info.CFBundleExecutable, "HelloXcode");
  assert.equal(info.CFBundleIdentifier, "com.example.HelloXcode");
  assert.equal(info.CFBundleShortVersionString, "1.0");
  assert.deepEqual(info.UIDeviceFamily, [1, 2]);
  assert.deepEqual(info.UILaunchScreen, {});
  assert.deepEqual(info.UIApplicationSceneManifest, { UIApplicationSupportsMultipleScenes: false });
});

test("dependencies are ordered before dependants", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const app = project.targetByName("HelloXcode");
  const tests = project.targetByName("HelloXcodeTests");
  const ordered = orderTargets(project, [tests, app]);
  assert.deepEqual(ordered.map((target) => target.name), ["HelloXcode", "HelloXcodeTests"]);
});

test("synchronized project plan compiles nested sources and copies resources", () => {
  const { plan } = makePlan({
    projectPath: fixture("ModernSync/ModernSync.xcodeproj"),
    targetName: "ModernSync",
  });
  const link = plan.steps.find((step) => step.kind === "link");
  assert.ok(link.command.args.some((arg) => arg.endsWith("Sub/Helper.swift")));
  assert.ok(!link.command.args.some((arg) => arg.endsWith("DevOnly.swift")));
  const copies = plan.steps.filter((step) => step.kind === "resource").map((step) => step.title);
  assert.ok(copies.some((title) => title.includes("Notes.md")));
  assert.ok(copies.some((title) => title.includes("Config.json")));
  assert.ok(!copies.some((title) => title.includes("Draft.json")));
});

test("generated Info.plist declares the platform and coerces orientation lists", () => {
  const { settings } = makePlan();
  const info = generatedInfoPlist(settings, { name: "HelloXcode" }, "iphonesimulator");
  assert.deepEqual(info.CFBundleSupportedPlatforms, ["iPhoneSimulator"]);
  assert.equal(info.DTPlatformName, "iphonesimulator");
  assert.equal(info.MinimumOSVersion, "17.0");
  assert.equal(info.UIRequiredDeviceCapabilities, undefined);
  assert.ok(Array.isArray(info.UISupportedInterfaceOrientations));
  assert.ok(Array.isArray(info.UISupportedInterfaceOrientations_iPad));
  assert.equal(settings.PRODUCT_BUNDLE_PACKAGE_TYPE, "APPL");
});

test("macOS Info.plist uses LSMinimumSystemVersion instead of MinimumOSVersion", () => {
  const { settings } = makePlan({ projectPath: fixture("HelloXcode/HelloXcode.xcodeproj") });
  const info = generatedInfoPlist(
    { ...settings, DEPLOYMENT_TARGET: "14.0" },
    { name: "HelloXcode" },
    "macosx",
  );
  assert.equal(info.MinimumOSVersion, undefined);
  assert.equal(info.LSMinimumSystemVersion, "14.0");
  assert.equal(info.LSRequiresIPhoneOS, undefined);
  assert.deepEqual(info.CFBundleSupportedPlatforms, ["MacOSX"]);
});

test("project-relative file settings resolve against SRCROOT", () => {
  const { settings } = makePlan();
  assert.equal(resolveProjectFile("Tests/Info.plist", settings), join(settings.SRCROOT, "Tests/Info.plist"));
  assert.equal(resolveProjectFile("$(SRCROOT)/Tests/Info.plist", settings), join(settings.SRCROOT, "Tests/Info.plist"));
  assert.equal(resolveProjectFile("/abs/Info.plist", settings), "/abs/Info.plist");
  assert.equal(resolveProjectFile("", settings), "");
});
