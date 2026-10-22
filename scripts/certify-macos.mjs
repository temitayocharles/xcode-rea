#!/usr/bin/env node
/**
 * One-shot macOS release gate. Produces the complete evidence report even
 * if settings parity fails, and never claims success without all four gates.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeSettingsReport, summarizeValueDifferences, summarizeMissingReferenceValues, summarizeOpaqueMissingFields } from "../src/compat/settings-summary.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = join(root, "docs/verification/macOS-final.json");
if (process.platform !== "darwin") {
  console.error("Mac certification needs macOS with a full Xcode installation.");
  process.exitCode = 2;
} else {
  console.log("== Stage 1: complete Node regression suite ==");
  const tests = spawnSync("npm", ["test"], { cwd: root, stdio: "inherit" });
  if (tests.error || tests.status !== 0) {
    console.error("Regression suite did not pass; macOS gate not run.");
    process.exitCode = tests.status || 1;
  } else {
    console.log("\n== Stage 2: real Xcode differential, build and signed product ==");
    const result = spawnSync(process.execPath, [
      "scripts/macos-verify.mjs",
      "--project", join(root, "tests/fixtures/HelloXcode/HelloXcode.xcodeproj"),
      "--scheme", "HelloXcode",
      "--configuration", "Debug",
      "--sdk", "iphonesimulator",
      "--derived-data", join(root, ".verify-derived-data"),
      "--json", reportPath,
    ], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, XCL_NO_CACHE: "1" },
    });
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        const failedSettings = report.gates?.some(
          (gate) => gate.name === "settings: resolved build settings" && gate.status === "fail",
        );
        if (failedSettings) {
          console.log("\n== All remaining mismatches, grouped by setting name ==");
          console.log(summarizeSettingsReport(report, { limit: 25 }));
          console.log("\n== Redacted expected-vs-actual values for unresolved mismatches ==");
          console.log(summarizeValueDifferences(report, { limit: 45 }));
          console.log("\n== Selected missing reference values (non-sensitive only) ==");
          console.log(summarizeMissingReferenceValues(report, { limit: 35 }));
          console.log("\n== Safe structural evidence for unresolved fields ==");
          console.log(summarizeOpaqueMissingFields(report));
        }
        console.log(`\nFull report: ${reportPath}`);
      } catch (error) {
        console.error(`Could not summarize report: ${error.message}`);
      }
    }
    const exitCode = result.error ? 2 : (result.status ?? 2);
    if (exitCode === 0) {
      console.log("Mac certification: PASS (all verified gates)");
    } else {
      console.error("Mac certification: INCOMPLETE (see report; do not merge/release)");
    }
    process.exitCode = exitCode;
  }
}
