#!/usr/bin/env node
/** Generate small binary-plist fixtures used by the test-suite. */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const value = {
  CFBundleName: "Hello",
  CFBundleVersion: "42",
  NSHighResolutionCapable: true,
  MinimumOSVersion: "17.0",
  BuildMachineOSBuild: "23F79",
  Items: ["alpha", "beta", 7],
  Ratio: 0.5,
};

function utf16be(string) {
  const buffer = Buffer.alloc(string.length * 2 + 2);
  for (let i = 0; i < string.length; i += 1) buffer.writeUInt16BE(string.charCodeAt(i), i * 2);
  return buffer;
}

function encodeInt(value) {
  if (value >= 0 && value <= 0xff) return Buffer.from([0x10, value]);
  if (value <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0x11;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x12;
  b.writeUInt32BE(value, 1);
  return b;
}

function encodeObject(object) {
  if (object.type === "int") return encodeInt(object.value);
  if (object.type === "real") {
    const b = Buffer.alloc(9);
    b[0] = 0x23;
    b.writeDoubleBE(object.value, 1);
    return b;
  }
  if (object.type === "bool") return Buffer.from([object.value ? 0x09 : 0x08]);
  if (object.type === "string") {
    const bytes = Buffer.from(object.value, "utf8");
    if (bytes.length < 15) return Buffer.concat([Buffer.from([0x50 + bytes.length]), bytes]);
    return Buffer.concat([Buffer.from([0x5f]), encodeInt(bytes.length), bytes]);
  }
  throw new Error("unsupported fixture object");
}

const objects = [];
const add = (object) => {
  objects.push(object);
  return objects.length - 1;
};

const keys = Object.keys(value);
const keyIndices = keys.map((key) => {
  const bytes = Buffer.from(key, "utf8");
  return add({ type: "string", value: bytes.toString("utf8") });
});

const valueIndices = Object.entries(value).map(([, item]) => {
  if (typeof item === "boolean") return add({ type: "bool", value: item });
  if (typeof item === "number" && Number.isInteger(item)) return add({ type: "int", value: item });
  if (typeof item === "number") return add({ type: "real", value: item });
  if (Array.isArray(item)) {
    const refs = item.map((entry) => {
      if (typeof entry === "string") return add({ type: "string", value: entry });
      if (typeof entry === "number") return add({ type: "int", value: entry });
      throw new Error("unsupported array entry");
    });
    return add({ type: "array", value: refs });
  }
  return add({ type: "string", value: item });
});

const refSize = 1;

function encodeDict(keys, values) {
  const header = Buffer.from([0xd0 | keys.length]);
  const refs = Buffer.alloc((keys.length + values.length) * refSize);
  keys.forEach((index, i) => {
    refs[i] = index;
    refs[keys.length + i] = values[i];
  });
  return Buffer.concat([header, refs]);
}

function encodeArray(refs) {
  return Buffer.concat([Buffer.from([0xa0 | refs.length]), Buffer.from(refs)]);
}

const dictIndex = add({ type: "dict", keys: keyIndices, values: valueIndices });
// Array object index is referenced above only through the dict; find it and encode.

const chunks = [];
const offsets = [];
let cursor = 8;
chunks.push(Buffer.from("bplist00", "latin1"));

function push(index) {
  offsets[index] = cursor;
  const object = objects[index];
  let bytes;
  if (object.type === "dict") bytes = encodeDict(object.keys, object.values);
  else if (object.type === "array") bytes = encodeArray(object.value);
  else bytes = encodeObject(object);
  chunks.push(bytes);
  cursor += bytes.length;
}

for (let i = 0; i < objects.length; i += 1) push(i);

const offsetTableOffset = cursor;
const offsetTable = Buffer.alloc(objects.length);
offsets.forEach((offset, i) => {
  offsetTable[i] = offset;
});
chunks.push(offsetTable);
cursor += offsetTable.length;

const trailer = Buffer.alloc(32);
trailer[6] = 1;
trailer[7] = 1;
trailer.writeBigUInt64BE(BigInt(objects.length), 8);
trailer.writeBigUInt64BE(BigInt(dictIndex), 16);
trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
chunks.push(trailer);

const output = process.argv[2] ?? "tests/fixtures/binary/sample.bplist";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat(chunks));
console.log(`wrote ${output} (${Buffer.concat(chunks).length} bytes)`);
