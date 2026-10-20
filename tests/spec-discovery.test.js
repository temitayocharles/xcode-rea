import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadXcodeSpecDefaults } from "../src/settings/spec.js";

test("Xcode spec discovery supports Plug-ins and SwiftBuild framework plugin roots", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "xcl-spec-discovery-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const developerDir = join(temp, "Contents", "Developer");
  const locations = [
    join(developerDir, "Library", "Xcode", "Plug-ins", "XCBSpecifications.ideplugin", "Contents", "Resources"),
    join(temp, "Contents", "SharedFrameworks", "SwiftBuild.framework", "Versions", "A",
      "PlugIns", "XCBBuildService.bundle", "Contents", "PlugIns", "XCBSpecifications.ideplugin",
      "Contents", "Resources"),
  ];
  locations.forEach((dir, index) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Swift.xcspec"), `[
      { Type = Compiler; Options = (
        { Name = "XCL_DISCOVERY_${index}"; Type = String; DefaultValue = "found-${index}"; }
      ); }
    ]`);
  });
  const result = loadXcodeSpecDefaults({ developerDir });
  assert.equal(result.warnings.length, 0, result.warnings.join("\n"));
  assert.equal(result.files.length, 2);
  assert.equal(result.defaults.XCL_DISCOVERY_0, "found-0");
  assert.equal(result.defaults.XCL_DISCOVERY_1, "found-1");
});
