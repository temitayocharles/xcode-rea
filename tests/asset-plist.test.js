import test from "node:test";
import assert from "node:assert/strict";
import { mergeAssetInfoPlists } from "../src/engine/execute.js";

test("actool icon keys merge without erasing unrelated Info.plist entries", () => {
  const base = {
    CFBundleIdentifier: "com.example.HelloXcode",
    CFBundleIcons: { CFBundleAlternateIcons: { Alt: { CFBundleIconName: "Alt" } } },
  };
  const generated = {
    CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: "AppIcon" } },
    "com.apple.actool.compilation-results": { "output-files": ["Assets.car"] },
  };
  const merged = mergeAssetInfoPlists(base, generated);
  assert.equal(merged.CFBundleIdentifier, "com.example.HelloXcode");
  assert.equal(merged.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName, "AppIcon");
  assert.ok(merged.CFBundleIcons.CFBundleAlternateIcons.Alt);
  assert.equal(merged["com.apple.actool.compilation-results"], undefined);
  assert.equal(base.CFBundleIcons.CFBundlePrimaryIcon, undefined);
});

test("actool metadata merging requires dictionaries", () => {
  assert.throws(() => mergeAssetInfoPlists({}, []), /requires property-list dictionaries/);
  assert.throws(() => mergeAssetInfoPlists(null, {}), /requires property-list dictionaries/);
});
