import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseOpenStep,
  stringifyOpenStep,
  parseXmlPlist,
  parsePlist,
  parseBinaryPlist,
  stringifyXmlPlist,
} from "../src/plist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

test("OpenStep parser handles comments, quoting, arrays and data", () => {
  const text = `// !$*UTF8*$!
{
  // line comment
  archiveVersion = 1;
  objects = {
    /* block comment */
    A = { path = "My App/File.swift"; sourceTree = "<group>"; };
    B = (one, "two words", 3,);
    C = <0a0b0c>;
    D = "line\\nbreak \\"quoted\\" \\U00e9";
  };
}`;
  const value = parseOpenStep(text);
  assert.equal(value.archiveVersion, "1");
  assert.equal(value.objects.A.path, "My App/File.swift");
  assert.deepEqual(value.objects.B, ["one", "two words", "3"]);
  assert.ok(Buffer.isBuffer(value.objects.C));
  assert.equal(value.objects.C.toString("hex"), "0a0b0c");
  assert.equal(value.objects.D, 'line\nbreak "quoted" é');
});

test("OpenStep round-trips through the serializer", () => {
  const value = {
    a: "plain",
    b: "with space",
    c: ["x", "y"],
    d: { nested: "value", data: Buffer.from([1, 2, 3]) },
    e: "",
  };
  const round = parseOpenStep(stringifyOpenStep(value));
  assert.deepEqual(round, value);
});

test("XML property lists convert to JS values", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Name</key><string>Hello &amp; goodbye</string>
  <key>Enabled</key><true/>
  <key>Disabled</key><false/>
  <key>Count</key><integer>42</integer>
  <key>Ratio</key><real>0.5</real>
  <key>Items</key>
  <array><string>a</string><integer>2</integer></array>
  <key>Blob</key><data>AQID</data>
</dict>
</plist>`;
  const value = parseXmlPlist(xml);
  assert.equal(value.Name, "Hello & goodbye");
  assert.equal(value.Enabled, true);
  assert.equal(value.Disabled, false);
  assert.equal(value.Count, 42);
  assert.equal(value.Ratio, 0.5);
  assert.deepEqual(value.Items, ["a", 2]);
  assert.equal(value.Blob.toString("hex"), "010203");
});

test("XML writer escapes special characters", () => {
  const xml = stringifyXmlPlist({ A: "<&>", B: [1, true] });
  const value = parseXmlPlist(xml);
  assert.deepEqual(value, { A: "<&>", B: [1, true] });
});

test("binary plist fixture parses", () => {
  const path = join(here, "fixtures/binary/sample.bplist");
  const value = parseBinaryPlist(readFileSync(path));
  assert.equal(value.CFBundleName, "Hello");
  assert.equal(value.CFBundleVersion, "42");
  assert.equal(value.NSHighResolutionCapable, true);
  assert.deepEqual(value.Items, ["alpha", "beta", 7]);
  assert.equal(value.Ratio, 0.5);
});

test("parsePlist detects all three formats", () => {
  const binary = parsePlist(readFileSync(join(here, "fixtures/binary/sample.bplist")));
  assert.equal(binary.CFBundleName, "Hello");

  const openstep = parsePlist("{ CFBundleName = Hi; }");
  assert.equal(openstep.CFBundleName, "Hi");

  const xml = parsePlist('<plist version="1.0"><dict><key>X</key><string>1</string></dict></plist>');
  assert.equal(xml.X, "1");
});

test("parses xcspec-style top-level arrays", () => {
  const value = parsePlist(`[
    { Identifier = "com.apple.buildsetting.example"; Type = String; DefaultValue = "YES"; },
    { Identifier = "com.apple.buildsetting.other"; DefaultValue = "$(inherited) -ObjC"; }
  ]`);
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 2);
  assert.equal(value[0].Identifier, "com.apple.buildsetting.example");
  assert.equal(value[1].DefaultValue, "$(inherited) -ObjC");
});
