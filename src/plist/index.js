import { readFileSync } from "node:fs";
import { parseOpenStep, stringifyOpenStep } from "./openstep.js";
import { parseBinaryPlist } from "./binary.js";
import { parseXml, findElement, textContent } from "./xml.js";

export { parseOpenStep, stringifyOpenStep, PlistSyntaxError } from "./openstep.js";
export { parseBinaryPlist, BinaryPlistError } from "./binary.js";
export { parseXml, findElement, findElements, textContent, XmlSyntaxError } from "./xml.js";

function xmlNodeToValue(node) {
  if (typeof node === "string") return node;
  switch (node.name) {
    case "plist": {
      const child = node.children.find((item) => typeof item !== "string" && item.name !== "#comment");
      return child ? xmlNodeToValue(child) : null;
    }
    case "dict": {
      const result = {};
      let pendingKey = null;
      for (const child of node.children) {
        if (typeof child === "string" || child.name === "#comment") continue;
        if (child.name === "key") {
          pendingKey = textContent(child);
        } else if (pendingKey !== null) {
          result[pendingKey] = xmlNodeToValue(child);
          pendingKey = null;
        }
      }
      return result;
    }
    case "array":
      return node.children
        .filter((child) => typeof child !== "string" && child.name !== "#comment")
        .map(xmlNodeToValue);
    case "string":
      return textContent(node);
    case "integer":
      return Number.parseInt(textContent(node).trim(), 10);
    case "real":
      return Number.parseFloat(textContent(node).trim());
    case "true":
      return true;
    case "false":
      return false;
    case "data":
      return Buffer.from(textContent(node).replace(/\s+/g, ""), "base64");
    case "date":
      return new Date(textContent(node).trim());
    case "null":
      return null;
    default:
      return textContent(node);
  }
}

export function parseXmlPlist(text) {
  const document = parseXml(text);
  const plist = findElement(document, "plist");
  if (!plist) {
    throw new Error("XML document does not contain a <plist> element");
  }
  return xmlNodeToValue(plist);
}

/**
 * Parse a property list of any of the three formats Xcode uses.
 * @param {Buffer|string} input
 */
export function parsePlist(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (buffer.length >= 8 && buffer.toString("latin1", 0, 8) === "bplist00") {
    return parseBinaryPlist(buffer);
  }
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const head = text.trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<!DOCTYPE") || head.startsWith("<plist")) {
    return parseXmlPlist(text);
  }
  return parseOpenStep(text);
}

/** @param {string} filePath */
export function readPlistFile(filePath) {
  return parsePlist(readFileSync(filePath));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function valueToXml(value, depth) {
  const pad = "\t".repeat(depth);
  if (value === null || value === undefined) return `${pad}<null/>`;
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }
  if (value instanceof Date) return `${pad}<date>${value.toISOString()}</date>`;
  if (Buffer.isBuffer(value)) return `${pad}<data>${value.toString("base64")}</data>`;
  if (typeof value === "string") return `${pad}<string>${xmlEscape(value)}</string>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    const body = value.map((item) => valueToXml(item, depth + 1)).join("\n");
    return `${pad}<array>\n${body}\n${pad}</array>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}<dict/>`;
    const body = entries
      .map(
        ([key, item]) =>
          `${"\t".repeat(depth + 1)}<key>${xmlEscape(key)}</key>\n${valueToXml(item, depth + 1)}`,
      )
      .join("\n");
    return `${pad}<dict>\n${body}\n${pad}</dict>`;
  }
  return `${pad}<string>${xmlEscape(value)}</string>`;
}

/**
 * Serialize a value as an XML property list (Xcode's modern format).
 */
export function stringifyXmlPlist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    valueToXml(value, 0),
    "</plist>",
    "",
  ].join("\n");
}
