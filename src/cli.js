import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv, resolveCommand, UsageError } from "./cli/parser.js";
import {
  allSchemes,
  buildEnvironment,
  loadProjects,
  makeSettingsResolver,
  parseDestination,
  platformFromSdkName,
} from "./cli/context.js";
import { loadXcodeSpecDefaults } from "./settings/spec.js";
import { detectToolchain, listSdks } from "./settings/toolchain.js";
import { planBuild } from "./engine/plan.js";
import { executePlan, summarizePlan } from "./engine/execute.js";
import { sortObjectByKey } from "./util/output.js";
import { runReaCommand } from "./rea/cli.js";
import { runStudioCommand } from "./studio/server.js";
import { runCompatCommand } from "./compat/report.js";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const USAGE = `xcl ${VERSION} — a lightweight, xcodebuild-compatible build tool

Usage: xcl [command] [options] [KEY=VALUE ...]

Commands:
  build                     Build a target or scheme (default command)
  clean                     Remove products and intermediates for a configuration
  list                      List targets, configurations and schemes (-list)
  show-build-settings       Print resolved build settings (-showBuildSettings)
  destinations              List installed SDKs as destinations (-showDestinations)
  doctor                    Check the local Xcode toolchain and xcl installation
  spec sync                 Import build-setting defaults from the installed Xcode
  rea plan                  Write an evidence-collection plan for REA
  rea import FILE...        Import REA evidence to extend xcl's compatibility table
  rea status                Summarise imported evidence
  compat report             Show which settings are backed by evidence
  capabilities              Print the machine-readable feature list
  studio                    Open the local project browser (web UI)
  version                   Print the xcl version
  help                      Print this help

Common options:
  -project PATH             Path to an .xcodeproj
  -workspace PATH           Path to an .xcworkspace
  -scheme NAME              Scheme to build or inspect
  -target NAME              Target to build (repeatable)
  -configuration NAME       Debug or Release
  -sdk NAME                 iphoneos, iphonesimulator, macosx, or an SDK path
  -destination SPEC         xcodebuild-style destination string
  -derivedDataPath PATH     Where to place build products
  -xcconfig PATH            Additional build settings file
  -arch ARCH                arm64 or x86_64
  -dry-run, --dry-run       Print the build plan without executing it
  -showdestinations         List available SDK destinations
  -json                     Machine-readable output
  -quiet                    Only print errors
  -verbose                  Echo tool output

xcodebuild compatibility:
  xcl xcodebuild -project App.xcodeproj -scheme App -configuration Debug build
  xcl -project App.xcodeproj -list
  xcl -project App.xcodeproj -showBuildSettings
  xcl -project App.xcodeproj -scheme App -dry-run

Examples:
  xcl -project App.xcodeproj -list --json
  xcl -project App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' build
  xcl studio -project App.xcodeproj --port 4173
  xcl rea plan && ./evidence/rea/collect.sh && xcl rea import evidence/rea/*.json
`;

function writeOut(text) {
  process.stdout.write(text);
}

function writeErr(text) {
  process.stderr.write(text);
}

function projectForTarget(context, target) {
  return (
    context.projects.find((project) => project.targets().some((entry) => entry.id === target.id)) ??
    context.primaryProject
  );
}

function listCommand(parsed) {
  const context = loadProjects(parsed);
  const schemes = allSchemes(context);
  const schemeNames = schemes.map((scheme) => scheme.name);
  const project = context.primaryProject;
  const projectInfo = {
    name: project.name,
    path: project.path,
    targets: project.targets().map((target) => target.name),
    configurations: project.configurationNames(),
    defaultConfiguration: project.defaultConfigurationName(),
    schemes: schemeNames,
    objectsVersion: project.objectVersion,
  };

  const workspaceInfo = context.workspace
    ? {
        name: context.workspace.name,
        path: context.workspacePath,
        projects: context.projects.map((entry) => entry.name),
        schemes: schemeNames,
      }
    : null;

  if (parsed.has("json")) {
    const output = { project: projectInfo };
    if (workspaceInfo) output.workspace = workspaceInfo;
    writeOut(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  if (workspaceInfo) {
    writeOut(`Information about workspace "${workspaceInfo.name}":\n`);
    writeOut(`    Projects:\n`);
    for (const name of workspaceInfo.projects) writeOut(`        ${name}\n`);
    writeOut(`\n    Schemes:\n`);
    if (schemeNames.length === 0) writeOut("        (none)\n");
    for (const name of schemeNames) writeOut(`        ${name}\n`);
    writeOut("\n");
  }

  for (const current of context.projects) {
    writeOut(`Information about project "${current.name}":\n`);
    writeOut(`    Targets:\n`);
    for (const target of current.targets()) writeOut(`        ${target.name}\n`);
    writeOut(`\n    Build Configurations:\n`);
    for (const configuration of current.configurationNames()) {
      writeOut(`        ${configuration}\n`);
    }
    writeOut(
      `\n    If no build configuration is specified and -scheme is not passed then "${current.defaultConfigurationName()}" is used.\n`,
    );
    writeOut(`\n    Schemes:\n`);
    if (schemeNames.length === 0) writeOut("        (none)\n");
    for (const name of schemeNames) writeOut(`        ${name}\n`);
    writeOut("\n");
  }
  return 0;
}

function showBuildSettingsCommand(parsed) {
  const context = loadProjects(parsed);
  const environment = buildEnvironment(parsed, context, { action: "build" });
  // -showBuildSettings is a configuration query, not an active compiler task.
  // Xcode reports CURRENT_ARCH=undefined_arch unless -arch selects an active
  // architecture. Keep the actual build planner's architecture unchanged.
  if (!parsed.get("arch")) {
    environment.overrides.CURRENT_ARCH = "undefined_arch";
  }
  const resolver = makeSettingsResolver(environment);
  const rows = [];
  const explicitSelection =
    (parsed.values.targets?.length ?? 0) > 0 || Boolean(parsed.get("scheme"));
  const targets = explicitSelection
    ? environment.targets
    : context.projects.flatMap((project) =>
        project.targets().map((target) => ({ project, target })),
      );

  for (const { target } of targets) {
    const { settings, warnings } = resolver(target);
    for (const warning of warnings) writeErr(`warning: ${target.name}: ${warning}\n`);
    rows.push({
      action: environment.action,
      buildSettings: sortObjectByKey(settings),
      target: target.name,
    });
  }

  if (parsed.has("json")) {
    writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  for (const row of rows) {
    writeOut(`Build settings for action ${row.action} and target ${row.target}:\n`);
    for (const [key, value] of Object.entries(row.buildSettings)) {
      writeOut(`    ${key} = ${value}\n`);
    }
    writeOut("\n");
  }
  return 0;
}

function groupTargetsByProject(context, targets) {
  const groups = new Map();
  for (const { project, target } of targets) {
    const owning = projectForTarget(context, target);
    if (!groups.has(owning)) groups.set(owning, []);
    groups.get(owning).push(target);
  }
  return groups;
}

function buildCommand(parsed) {
  const context = loadProjects(parsed);
  const environment = buildEnvironment(parsed, context, { action: "build" });
  const resolver = makeSettingsResolver(environment);
  const groups = groupTargetsByProject(context, environment.targets);
  const plans = [];
  const warnings = [];

  for (const [project, targets] of groups) {
    const projectPlan = planBuild({
      project,
      targets,
      configuration: environment.configuration,
      resolveSettings: resolver,
      platform: environment.platform,
      arch: environment.arch,
      sdkPath: environment.sdk?.path ?? null,
      deploymentTarget: null,
    });
    plans.push(...projectPlan.targets);
    warnings.push(...projectPlan.warnings);
  }

  for (const warning of warnings) writeErr(`warning: ${warning}\n`);

  const dryRun = parsed.has("dry-run");
  const quiet = parsed.has("quiet") || parsed.has("json");
  const verbose = parsed.has("verbose");

  if (!quiet) {
    for (const plan of plans) {
      writeOut(
        `Building ${plan.target.name} (${environment.configuration}, ${environment.platform}, ${environment.arch})\n`,
      );
      writeOut(`  product: ${plan.target.productPath}\n`);
    }
    writeOut("\n");
  }

  const started = Date.now();
  let stepCount = 0;
  try {
    for (const plan of plans) {
      executePlan(plan, {
        dryRun,
        quiet,
        verbose,
        write: parsed.has("json") ? () => {} : writeOut,
        writeError: writeErr,
      });
      stepCount += plan.steps.length;
    }
  } catch (error) {
    if (error.name === "BuildError" && error.step) {
      writeErr(`error: ${error.message}\n`);
      writeErr(`failed command: ${error.step.display}\n`);
      return 1;
    }
    throw error;
  }
  const durationMs = Date.now() - started;

  if (parsed.has("json")) {
    writeOut(
      `${JSON.stringify(
        {
          status: dryRun ? "planned" : "succeeded",
          configuration: environment.configuration,
          platform: environment.platform,
          arch: environment.arch,
          durationMs,
          targets: plans.map(summarizePlan),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (!quiet) {
    if (dryRun) {
      writeOut(`\n** DRY RUN COMPLETE ** ${stepCount} steps planned\n`);
    } else {
      writeOut(`\n** BUILD SUCCEEDED ** ${stepCount} steps in ${(durationMs / 1000).toFixed(1)}s\n`);
    }
  }
  return 0;
}

function cleanCommand(parsed) {
  const context = loadProjects(parsed);
  const environment = buildEnvironment(parsed, context, { action: "clean" });
  const resolver = makeSettingsResolver(environment);
  const removed = [];

  for (const { target } of environment.targets) {
    const { settings } = resolver(target);
    const product =
      settings.BUILT_PRODUCTS_DIR && settings.FULL_PRODUCT_NAME
        ? join(settings.BUILT_PRODUCTS_DIR, settings.FULL_PRODUCT_NAME)
        : null;
    const candidates = [
      product,
      product ? `${product}.dSYM` : null,
      settings.TARGET_TEMP_DIR,
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    }
  }

  if (parsed.has("json")) {
    writeOut(`${JSON.stringify({ removed }, null, 2)}\n`);
    return 0;
  }
  if (removed.length === 0) {
    writeOut("Nothing to clean.\n");
  } else {
    for (const path of [...new Set(removed)]) writeOut(`removed ${path}\n`);
    writeOut("\n** CLEAN SUCCEEDED **\n");
  }
  return 0;
}

function doctorCommand(parsed) {
  const toolchain = detectToolchain();
  const checks = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "Node.js",
    status: nodeMajor >= 20 ? "ok" : "error",
    detail: process.version,
  });
  checks.push({
    name: "platform",
    status: process.platform === "darwin" ? "ok" : "warn",
    detail:
      process.platform === "darwin"
        ? `${process.platform} ${process.arch}`
        : `${process.platform} ${process.arch} — planning works, building requires macOS`,
  });
  checks.push({
    name: "Xcode toolchain",
    status: toolchain.found ? "ok" : "warn",
    detail: toolchain.found
      ? `${toolchain.developerDir}${toolchain.version ? ` (Xcode ${toolchain.version})` : ""}`
      : "not found; set DEVELOPER_DIR or install Xcode / Command Line Tools",
  });

  if (toolchain.found) {
    for (const platform of ["macosx", "iphoneos", "iphonesimulator"]) {
      const sdks = listSdks({ developerDir: toolchain.developerDir, platform });
      checks.push({
        name: `SDK ${platform}`,
        status: sdks.length > 0 ? "ok" : "warn",
        detail: sdks.length > 0 ? sdks.map((sdk) => sdk.name).join(", ") : "no SDK installed",
      });
    }
  }

  const spec = toolchain.found
    ? loadXcodeSpecDefaults({ developerDir: toolchain.developerDir })
    : { defaults: {}, files: [], warnings: [] };
  checks.push({
    name: "Xcode build-setting specs",
    status: spec.files.length > 0 ? "ok" : "warn",
    detail:
      spec.files.length > 0
        ? `${Object.keys(spec.defaults).length} defaults from ${spec.files.length} .xcspec files`
        : "not found (install full Xcode to import authoritative defaults)",
  });

  const evidencePath = resolve("compat/evidence.json");
  checks.push({
    name: "REA evidence",
    status: existsSync(evidencePath) ? "ok" : "warn",
    detail: existsSync(evidencePath)
      ? evidencePath
      : "no compat/evidence.json yet; run `xcl rea plan` then import results",
  });

  if (parsed.has("json")) {
    writeOut(
      `${JSON.stringify({ version: VERSION, toolchain, checks, spec: { count: Object.keys(spec.defaults).length, files: spec.files } }, null, 2)}\n`,
    );
    return 0;
  }

  writeOut(`xcl ${VERSION}\n\n`);
  for (const check of checks) {
    const marker = check.status === "ok" ? "[ok]  " : check.status === "warn" ? "[warn]" : "[fail]";
    writeOut(`${marker} ${check.name}: ${check.detail}\n`);
  }
  return checks.some((check) => check.status === "error") ? 1 : 0;
}

function specCommand(parsed) {
  const action = parsed.positionals[0] ?? "show";
  const toolchain = detectToolchain();
  if (!toolchain.found) {
    writeErr("error: no Xcode toolchain found; set DEVELOPER_DIR\n");
    return 1;
  }
  if (action === "sync") {
    const spec = loadXcodeSpecDefaults({ developerDir: toolchain.developerDir });
    const outPath = resolve(parsed.get("out") ?? "compat/xcode-spec-defaults.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          xcode: {
            developerDir: toolchain.developerDir,
            version: toolchain.version,
            build: toolchain.build,
          },
          files: spec.files,
          defaults: sortObjectByKey(spec.defaults),
          definitions: spec.definitions,
        },
        null,
        2,
      )}\n`,
    );
    writeOut(
      `Imported ${Object.keys(spec.defaults).length} build-setting defaults from ${spec.files.length} .xcspec files.\n`,
    );
    writeOut(`Wrote ${outPath}\n`);
    if (spec.warnings.length > 0) {
      writeErr(`${spec.warnings.length} spec files could not be read.\n`);
    }
    return 0;
  }
  if (action === "show" || action === "list") {
    const spec = loadXcodeSpecDefaults({ developerDir: toolchain.developerDir });
    if (parsed.has("json")) {
      writeOut(
        `${JSON.stringify(
          {
            files: spec.files,
            count: Object.keys(spec.defaults).length,
            defaults: sortObjectByKey(spec.defaults),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    writeOut(`${Object.keys(spec.defaults).length} defaults from ${spec.files.length} files:\n`);
    for (const [key, value] of Object.entries(sortObjectByKey(spec.defaults)).slice(0, 40)) {
      writeOut(`    ${key} = ${value}\n`);
    }
    return 0;
  }
  throw new UsageError(`unknown spec action: ${action}`);
}

function destinationsCommand(parsed) {
  const toolchain = detectToolchain();
  const rows = [];
  for (const platform of ["iphoneos", "iphonesimulator", "macosx", "appletvos", "appletvsimulator", "watchos", "watchsimulator"]) {
    for (const sdk of listSdks({ developerDir: toolchain.developerDir, platform })) {
      rows.push({
        platform,
        sdk: sdk.name,
        version: sdk.version,
        available: true,
      });
    }
  }
  if (parsed.has("json")) {
    writeOut(`${JSON.stringify({ destinations: rows }, null, 2)}\n`);
  } else {
    writeOut("Available destinations (from installed SDKs):\n");
    if (rows.length === 0) writeOut("    (none)\n");
    for (const row of rows) {
      writeOut(`    { platform:${row.platform}, sdk:${row.sdk} }\n`);
    }
  }
  return 0;
}

function versionCommand() {
  writeOut(`xcl ${VERSION}\n`);
  writeOut(`node ${process.version} ${process.platform} ${process.arch}\n`);
  return 0;
}

async function dispatch(argv) {
  const parsed = parseArgv(argv);
  const command = resolveCommand(parsed);

  if (parsed.has("help") || command === "help") {
    writeOut(USAGE);
    return 0;
  }
  if (command === "version") return versionCommand();

  switch (command) {
    case "list":
      return listCommand(parsed);
    case "show-build-settings":
    case "showbuildsettings":
      return showBuildSettingsCommand(parsed);
    case "build":
    case "analyze":
    case "archive":
      return buildCommand(parsed);
    case "clean":
      return cleanCommand(parsed);
    case "destinations":
      return destinationsCommand(parsed);
    case "doctor":
      return doctorCommand(parsed);
    case "spec":
      return specCommand(parsed);
    case "rea":
      return runReaCommand(parsed);
    case "compat":
      return runCompatCommand(parsed);
    case "studio":
      return runStudioCommand(parsed);
    case "test":
    case "run":
    case "install":
      writeErr(
        `error: "${command}" is not implemented yet. xcl currently builds, lists, and resolves settings.\n` +
          "Use `xcl build` and run the product with the simulator or `open`.\n",
      );
      return 2;
    case "capabilities":
      writeOut(
        `${JSON.stringify(
          {
            commands: [
              "build",
              "clean",
              "list",
              "show-build-settings",
              "destinations",
              "doctor",
              "spec",
              "rea",
              "compat",
              "studio",
              "capabilities",
              "version",
            ],
            productTypes: [
              "com.apple.product-type.application",
              "com.apple.product-type.framework",
              "com.apple.product-type.library.static",
              "com.apple.product-type.library.dynamic",
              "com.apple.product-type.bundle.unit-test",
              "com.apple.product-type.bundle.ui-testing",
              "com.apple.product-type.app-extension",
              "com.apple.product-type.bundle",
              "com.apple.product-type.tool",
            ],
            projectObjectVersions: "46-77",
            swift: true,
            objectiveC: true,
            xcconfig: true,
            workspaces: true,
            schemes: true,
            signing: "ad-hoc",
            testExecution: false,
            interfaceBuilderEditing: false,
            packageResolution: false,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

export async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      writeErr(`error: ${error.message}\n`);
      writeErr("Run `xcl help` for usage.\n");
      return 2;
    }
    if (
      ["ProjectError", "XcconfigError", "WorkspaceError", "SchemeError", "PlistSyntaxError", "XmlSyntaxError"].includes(
        error.name,
      )
    ) {
      writeErr(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export { USAGE };
