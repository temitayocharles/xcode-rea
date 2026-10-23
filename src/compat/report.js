import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { genericDefaults } from "../settings/defaults.js";
import { sortObjectByKey } from "../util/output.js";

function builtInSettingNames() {
  const project = {
    name: "Report",
    path: resolve("Report.xcodeproj"),
  };
  const target = {
    id: "0",
    name: "Report",
    productType: "com.apple.product-type.application",
    productName: "Report",
  };
  const settings = genericDefaults({
    project,
    projectPath: project.path,
    target,
    configuration: "Debug",
    platform: "iphonesimulator",
    sdk: { name: "iphonesimulator18.0", version: "18.0", path: "/SDK", root: "iphonesimulator", defaultProperties: {} },
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: resolve("DerivedData"),
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    action: "build",
  });
  return settings;
}

function evidenceCoverage(evidence) {
  const implemented = builtInSettingNames();
  const implementedNames = new Set(Object.keys(implemented));
  const evidenceNames = Object.keys(evidence.buildSettings ?? {});
  const covered = evidenceNames.filter((name) => implementedNames.has(name));
  const missing = evidenceNames.filter((name) => !implementedNames.has(name));
  return { implementedNames, evidenceNames, covered, missing };
}

export function runCompatCommand(parsed) {
  const action = parsed.positionals[0] ?? "report";
  const evidencePath = resolve(parsed.get("out") ?? "compat/evidence.json");

  if (action !== "report" && action !== "status" && action !== "verify") {
    throw new Error(`unknown compat action: ${action}`);
  }

  if (!existsSync(evidencePath)) {
    process.stdout.write(
      [
        "No REA evidence imported yet.",
        "",
        "Recommended flow on the Mac:",
        "  1. xcl rea plan                 # writes evidence/rea/collect.sh",
        "  2. ./evidence/rea/collect.sh    # runs REA against Xcode",
        "  3. xcl rea import evidence/rea/*.json",
        "  4. xcl compat report",
        "",
        "Without evidence, xcl still uses its built-in defaults and the",
        "installed Xcode's .xcspec files (`xcl spec sync`).",
        "",
      ].join("\n"),
    );
    return 0;
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    process.stderr.write(`error: cannot parse ${evidencePath}: ${error.message}\n`);
    return 1;
  }

  const { implementedNames, evidenceNames, covered, missing } = evidenceCoverage(evidence);
  const percentage =
    evidenceNames.length === 0 ? 0 : Math.round((covered.length / evidenceNames.length) * 100);

  if (parsed.has("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          evidencePath,
          sources: evidence.sources?.length ?? 0,
          builtInSettings: implementedNames.size,
          evidenceSettings: evidenceNames.length,
          covered: covered.length,
          coveragePercent: percentage,
          missing,
          frameworks: evidence.frameworks ?? [],
          libraries: evidence.libraries ?? [],
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`xcl compatibility report\n`);
  process.stdout.write(`  evidence: ${evidencePath}\n`);
  process.stdout.write(`  built-in settings: ${implementedNames.size}\n`);
  process.stdout.write(
    `  evidence-backed settings: ${evidenceNames.length} (${covered.length} implemented, ${percentage}%)\n`,
  );
  if (missing.length > 0) {
    process.stdout.write(`\nSettings observed in Xcode but not yet implemented (${missing.length}):\n`);
    for (const name of missing.slice(0, 80)) {
      const record = evidence.buildSettings[name];
      process.stdout.write(
        `  ${name} (${record.observations} observation(s), ${record.sources.length} source(s))\n`,
      );
    }
    if (missing.length > 80) process.stdout.write(`  ... and ${missing.length - 80} more\n`);
  } else if (evidenceNames.length > 0) {
    process.stdout.write("\nEvery observed setting is implemented.\n");
  }

  const builtInOnly = [...implementedNames].filter((name) => !evidenceNames.includes(name));
  process.stdout.write(`\nSettings implemented from Xcode documentation/defaults: ${builtInOnly.length}\n`);
  return 0;
}

export { builtInSettingNames };
