import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReaPlan, renderCollectScript, renderReaReadme } from "../src/rea/plan.js";
import { extractEvidence, mergeEvidence, isCandidateSetting } from "../src/rea/import.js";

test("REA plan targets Xcode's build-system components", () => {
  const plan = buildReaPlan({ xcodeApp: "/Applications/Xcode.app", outDir: "evidence/rea" });
  const ids = plan.components.map((component) => component.id);
  assert.ok(ids.includes("xcodebuild"));
  assert.ok(ids.includes("xcbuild"));
  assert.ok(ids.includes("devtoolscore"));
  assert.ok(plan.commands.every((entry) => entry.command.startsWith("rea ")));
  assert.ok(plan.commands.some((entry) => entry.command.includes("inspect-native-dispatch-metadata")));
  assert.ok(plan.commands.some((entry) => entry.command.includes("inspect-artifact")));
  assert.ok(plan.commands.every((entry) => entry.command.includes("--format json")));
});

test("collect script is valid bash shape", () => {
  const plan = buildReaPlan({ xcodeApp: "/Applications/Xcode.app" });
  const script = renderCollectScript(plan);
  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /OUT="\$\{OUT:-evidence\/rea\}"/);
  assert.match(script, /run\(\) \{/);
  assert.ok(!script.includes("${XCODE_WINDOW_ID:?"));
});

test("REA readme explains evidence authority", () => {
  const plan = buildReaPlan({});
  const readme = renderReaReadme(plan);
  assert.match(readme, /REA/);
  assert.match(readme, /xcl rea import/);
  assert.match(readme, /does not prove/);
});

test("candidate setting filter rejects noise", () => {
  assert.equal(isCandidateSetting("PRODUCT_BUNDLE_IDENTIFIER"), true);
  assert.equal(isCandidateSetting("SWIFT_VERSION"), true);
  assert.equal(isCandidateSetting("YES"), false);
  assert.equal(isCandidateSetting("arm64"), false);
  assert.equal(isCandidateSetting("Debug"), false);
});

test("evidence extraction records counts and source hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-evidence-"));
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  writeFileSync(
    first,
    JSON.stringify({
      settings: ["PRODUCT_NAME", "SWIFT_VERSION", "not a setting"],
      frameworks: ["/SDKs/UIKit.framework/UIKit"],
    }),
  );
  writeFileSync(
    second,
    JSON.stringify({
      nested: { more: ["PRODUCT_NAME", "CLANG_ENABLE_MODULES"] },
      dylib: "/usr/lib/libSystem.B.dylib",
    }),
  );
  const evidence = extractEvidence([first, second]);
  assert.equal(evidence.sources.length, 2);
  assert.ok(evidence.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256)));
  assert.equal(evidence.buildSettings.PRODUCT_NAME.observations, 2);
  assert.equal(evidence.buildSettings.PRODUCT_NAME.sources.length, 2);
  assert.equal(evidence.buildSettings.CLANG_ENABLE_MODULES.observations, 1);
  assert.ok(evidence.frameworks.includes("UIKit"));
  assert.ok(evidence.libraries.includes("libSystem.B"));
});

test("mergeEvidence accumulates observations and keeps sources unique", () => {
  const left = {
    schemaVersion: 1,
    sources: [{ file: "a.json", sha256: "a", bytes: 1 }],
    buildSettings: { PRODUCT_NAME: { observations: 2, sources: ["a.json"] } },
    classes: {},
    frameworks: ["UIKit"],
    libraries: [],
  };
  const right = {
    schemaVersion: 1,
    sources: [{ file: "b.json", sha256: "b", bytes: 1 }],
    buildSettings: { PRODUCT_NAME: { observations: 3, sources: ["a.json", "b.json"] } },
    classes: { NSObject: { observations: 1, sources: ["b.json"] } },
    frameworks: ["UIKit", "Foundation"],
    libraries: ["libz"],
  };
  const merged = mergeEvidence(left, right);
  assert.equal(merged.buildSettings.PRODUCT_NAME.observations, 5);
  assert.deepEqual(merged.buildSettings.PRODUCT_NAME.sources, ["a.json", "b.json"]);
  assert.deepEqual(merged.frameworks, ["Foundation", "UIKit"]);
  assert.deepEqual(merged.libraries, ["libz"]);
  assert.equal(merged.sources.length, 2);
});
