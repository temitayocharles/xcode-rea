#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeSettingsReport } from "../src/compat/settings-summary.js";

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node scripts/settings-summary.mjs PATH/REPORT.json [--limit 12]");
    return;
  }
  const [path, ...rest] = argv;
  if (!path) throw new Error("report JSON path is required");
  let limit = 12;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--limit" && rest[index + 1]) {
      limit = Number(rest[++index]);
    } else {
      throw new Error(`unrecognized option: ${rest[index]}`);
    }
  }
  const report = JSON.parse(readFileSync(resolve(path), "utf8"));
  process.stdout.write(summarizeSettingsReport(report, { limit }) + "\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`settings summary: ${error.message}`);
  process.exitCode = 1;
}
