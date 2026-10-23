import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadProject } from "../src/xcode/pbxproj.js";
import { loadScheme, schemeBlueprintIds } from "../src/xcode/scheme.js";
import { Workspace, findSchemes } from "../src/xcode/workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

test("HelloXcode project parses targets and configurations", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  assert.equal(project.name, "HelloXcode");
  assert.equal(project.objectVersion, "60");
  assert.deepEqual(project.configurationNames(), ["Debug", "Release"]);
  assert.deepEqual(
    project.targets().map((target) => target.name),
    ["HelloXcode", "HelloXcodeTests"],
  );
  const app = project.targetByName("HelloXcode");
  assert.equal(app.productType, "com.apple.product-type.application");
  assert.equal(project.productPath(app.id), "$(BUILT_PRODUCTS_DIR)/HelloXcode.app");
});

test("HelloXcode resolves source and resource paths", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const app = project.targetByName("HelloXcode");
  const sources = project.sources(app.id).map((entry) => entry.path);
  assert.equal(sources.length, 2);
  assert.ok(sources[0].endsWith("HelloXcode/AppDelegate.swift"));
  assert.ok(sources[1].endsWith("HelloXcode/ContentView.swift"));

  const resources = project.resources(app.id);
  assert.equal(resources.length, 2);
  assert.ok(resources.every((entry) => entry.kind === "asset-catalog"));
  assert.ok(resources[1].path.endsWith("Preview Content/Preview Assets.xcassets"));
});

test("target dependencies are exposed with their target", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const tests = project.targetByName("HelloXcodeTests");
  const dependencies = project.dependencies(tests.id);
  assert.equal(dependencies.length, 1);
  assert.equal(dependencies[0].name, "HelloXcode");
  assert.equal(dependencies[0].targetId, project.targetByName("HelloXcode").id);
});

test("synchronized groups include files and honour exceptions", () => {
  const project = loadProject(fixture("ModernSync/ModernSync.xcodeproj"));
  const app = project.targetByName("ModernSync");
  const sources = project.sources(app.id).map((entry) => entry.relativePath);
  assert.deepEqual(sources, ["App.swift", "ContentView.swift", "Sub/Helper.swift"]);
  assert.ok(!sources.includes("DevOnly.swift"));

  const resources = project.resources(app.id).map((entry) => entry.relativePath);
  assert.ok(resources.includes("Assets.xcassets"));
  assert.ok(resources.includes("Resources/Config.json"));
  assert.ok(!resources.includes("Resources/Draft.json"));
  assert.ok(resources.includes("Notes.md"));
  assert.ok(!resources.includes("Info.plist"));

  const tests = project.targetByName("ModernSyncTests");
  assert.deepEqual(
    project.sources(tests.id).map((entry) => entry.relativePath),
    ["ModernSyncTests.swift"],
  );
});

test("scheme parsing returns build entries and configurations", () => {
  const scheme = loadScheme(
    fixture("HelloXcode/HelloXcode.xcodeproj/xcshareddata/xcschemes/HelloXcode.xcscheme"),
  );
  assert.equal(scheme.name, "HelloXcode");
  assert.equal(scheme.build.entries.length, 2);
  assert.equal(scheme.launch.buildConfiguration, "Debug");
  assert.equal(scheme.archive.buildConfiguration, "Release");
  assert.equal(scheme.test.testables.length, 1);
  assert.deepEqual(schemeBlueprintIds(scheme, "test"), [
    "000000000000000000000006",
    "000000000000000000000007",
  ]);
  assert.deepEqual(schemeBlueprintIds(scheme, "run"), ["000000000000000000000006"]);
});

test("workspace references resolve to project paths", () => {
  const workspace = Workspace.load(fixture("HelloXcode/HelloXcode.xcworkspace"));
  assert.equal(workspace.name, "HelloXcode");
  const projects = workspace.projects();
  assert.equal(projects.length, 1);
  assert.ok(projects[0].path.endsWith("HelloXcode.xcodeproj"));
});

test("schemes are discovered from project and workspace containers", () => {
  const projectSchemes = findSchemes(fixture("HelloXcode/HelloXcode.xcodeproj"));
  assert.deepEqual(projectSchemes.map((scheme) => scheme.name), ["HelloXcode"]);
  const workspaceSchemes = findSchemes(fixture("HelloXcode/HelloXcode.xcworkspace"));
  assert.deepEqual(workspaceSchemes.map((scheme) => scheme.name), []);
});

test("loading project.pbxproj directly resolves paths like the .xcodeproj", () => {
  const directory = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const file = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj/project.pbxproj"));
  assert.equal(file.name, "HelloXcode");
  assert.equal(file.projectDir, directory.projectDir);
  assert.deepEqual(
    file.targetByName("HelloXcode") && file.sources(file.targetByName("HelloXcode").id),
    directory.sources(directory.targetByName("HelloXcode").id),
  );
});
