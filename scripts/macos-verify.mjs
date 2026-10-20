#!/usr/bin/env node
/**
 * Differential verification against real Xcode.
 *
 * Runs four gates on macOS and exits non-zero if any fails:
 *
 *   1. structure  - `xcodebuild -list` and `xcl -list` agree
 *   2. settings   - resolved build settings agree for every target
 *   3. build      - `xcl build` produces a launchable product
 *   4. product    - the product is a signed bundle with the right architecture
 *
 * Usage:
 *   node scripts/macos-verify.mjs --project Path/App.xcodeproj --scheme App
 *                                 [--configuration Debug] [--sdk iphonesimulator]
 *                                 [--derived-data /tmp/xcl-verify] [--json report.json]
 *                                 [--ignore-key SOME_KEY ...] [--skip-build]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSettings, diffList, ignoredKeys } from "../src/compat/diff.js";



function parseArgs(argv) {
  const options = {
    configuration: "Debug",
    sdk: "iphonesimulator",
    derivedData: join(process.cwd(), ".verify-derived-data"),
    scheme: null,
    project: null,
    json: null,
    skipBuild: false,
    ignoreKeys: ignoredKeys(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    switch (arg) {
      case "--project":
        options.project = resolve(next());
        break;
      case "--scheme":
        options.scheme = next();
        break;
      case "--configuration":
        options.configuration = next();
        break;
      case "--sdk":
        options.sdk = next();
        break;
      case "--derived-data":
        options.derivedData = resolve(next());
        break;
      case "--json":
        options.json = resolve(next());
        break;
      case "--ignore-key":
        options.ignoreKeys.add(next());
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: node scripts/macos-verify.mjs --project X.xcodeproj [-scheme NAME] [--configuration Debug] [--sdk iphonesimulator]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.project) throw new Error("--project is required");
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function runSoft(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gate(name, fn) {
  process.stdout.write(`\n== ${name}\n`);
  try {
    const detail = fn();
    process.stdout.write(`   PASS ${detail.summary ?? ""}\n`);
    for (const line of detail.lines ?? []) process.stdout.write(`        ${line}\n`);
    return { name, status: "pass", ...detail };
  } catch (error) {
    process.stdout.write(`   FAIL ${error.message}\n`);
    return { name, status: "fail", error: error.message, lines: error.lines ?? [] };
  }
}

function selection(options) {
  const args = ["-project", options.project];
  if (options.scheme) args.push("-scheme", options.scheme);
  return args;
}

function xclArgs(options, command) {
  return [
    "bin/xcl.mjs",
    ...selection(options),
    "-configuration",
    options.configuration,
    "-sdk",
    options.sdk,
    "-derivedDataPath",
    options.derivedData,
    ...command,
  ];
}

function listGate(options, root) {
  const xcode = JSON.parse(
    run("xcodebuild", [...selection(options), "-list", "-json"], { cwd: root }),
  );
  const xcl = JSON.parse(run(process.execPath, xclArgs(options, ["-list", "--json"]), { cwd: root }));

  const reference = xcode.project ?? xcode.workspace;
  const actual = xcl.project;
  if (!reference) throw new Error("xcodebuild -list did not report a project");

  const diff = diffList(reference, actual);
  if (!diff.ok) {
    const error = new Error(`${diff.differences.length} structural difference(s)`);
    error.lines = diff.differences;
    throw error;
  }
  return {
    summary: `${actual.targets.length} targets, ${actual.configurations.length} configurations`,
    targets: actual.targets,
  };
}

function settingsFor(command, args, target, root) {
  const output = run(command, [...args, "-target", target], { cwd: root });
  const parsed = JSON.parse(output);
  const entry = parsed.find((item) => item.target === target) ?? parsed[0];
  if (!entry) throw new Error(`no build settings returned for ${target}`);
  return entry.buildSettings;
}

function settingsGate(options, root, targets) {
  const referenceByTarget = new Map();
  const actualByTarget = new Map();
  for (const target of targets) {
    referenceByTarget.set(
      target,
      settingsFor(
        "xcodebuild",
        [...selection(options), "-configuration", options.configuration, "-sdk", options.sdk, "-showBuildSettings", "-json"],
        target,
        root,
      ),
    );
    actualByTarget.set(
      target,
      settingsFor(process.execPath, xclArgs(options, ["-showBuildSettings", "--json"]), target, root),
    );
  }

  const result = compareSettings(referenceByTarget, actualByTarget, {
    ignore: options.ignoreKeys,
  });
  const detail = {
    summary: `${result.compared} settings compared, ${result.differing} differing, ${result.unimplemented} unimplemented (${result.coverage.toFixed(1)}% covered)`,
    lines: result.lines,
    compared: result.compared,
    differing: result.differing,
    unimplemented: result.unimplemented,
    coverage: result.coverage,
  };
  if (!result.ok) {
    const error = new Error(
      `${result.differing} value mismatches, ${result.unimplemented} missing settings`,
    );
    error.lines = result.lines;
    throw error;
  }
  return detail;
}

function buildGate(options, root) {
  if (existsSync(options.derivedData)) rmSync(options.derivedData, { recursive: true, force: true });
  mkdirSync(options.derivedData, { recursive: true });

  const result = spawnSync(
    process.execPath,
    xclArgs(options, ["build"]),
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const error = new Error(`xcl build failed with exit code ${result.status}`);
    error.lines = [result.stdout, result.stderr].filter(Boolean).join("\n").split("\n").slice(-25);
    throw error;
  }

  const plan = JSON.parse(run(process.execPath, xclArgs(options, ["build", "--dry-run", "--json"]), { cwd: root }));
  const products = plan.targets
    .map((target) => target.product)
    .filter((path) => path && existsSync(path));
  if (products.length === 0) throw new Error("build succeeded but no product was found on disk");

  return { summary: products.join(", "), products };
}

function productGate(options, build) {
  const lines = [];
  const bundles = (build.products ?? []).filter((product) =>
    /\.(app|appex|xctest)$/.test(product),
  );
  if (bundles.length === 0) throw new Error("no application bundle among the build products");

  for (const product of bundles) {
    const name = product.split("/").pop();
    const plist = [
      join(product, "Info.plist"),
      join(product, "Contents", "Info.plist"),
    ].find((path) => existsSync(path));
    if (!plist) throw new Error(`missing Info.plist in ${product}`);

    const lint = runSoft("plutil", ["-lint", plist]);
    if (!lint.ok || !/OK$/.test(lint.stdout.trim())) {
      throw new Error(`Info.plist is not a valid property list: ${product}`);
    }

    const verify = runSoft("codesign", ["--verify", "--deep", "--strict", product]);
    if (!verify.ok) {
      throw new Error(
        `codesign verification failed for ${product}: ${verify.stderr.trim().split("\n").slice(-2).join(" ")}`,
      );
    }

    const stem = name.replace(/\.(app|appex|xctest)$/, "");
    const executable = [
      join(product, "Contents", "MacOS", stem),
      join(product, stem),
    ].find((path) => existsSync(path));
    if (!executable) throw new Error(`no executable found inside ${product}`);

    const arches = run("lipo", ["-archs", executable]).trim();
    if (!arches) throw new Error(`could not determine architecture of ${executable}`);
    lines.push(`${name}: ${arches}`);
  }
  return { summary: "signed bundle with expected architecture", lines };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

  if (process.platform !== "darwin") {
    process.stderr.write(
      `This gate needs macOS with Xcode installed (running on ${process.platform}).\n` +
        "Use `npm test` and `xcl --dry-run` for platform-independent checks.\n",
    );
    process.exit(2);
  }
  if (!existsSync(join(root, "bin", "xcl.mjs"))) {
    process.stderr.write("run this script from the repository root\n");
    process.exit(2);
  }
  if (!existsSync(options.project)) {
    process.stderr.write(`project not found: ${options.project}\n`);
    process.exit(2);
  }

  const gates = [];
  let targets = [];
  gates.push(
    gate("structure: xcodebuild -list == xcl -list", () => {
      const detail = listGate(options, root);
      targets = detail.targets ?? [];
      return detail;
    }),
  );
  if (targets.length > 0) {
    gates.push(
      gate("settings: resolved build settings", () => settingsGate(options, root, targets)),
    );
  }

  let build = null;
  if (!options.skipBuild) {
    const buildResult = gate("build: xcl build", () => {
      build = buildGate(options, root);
      return build;
    });
    gates.push(buildResult);
    if (buildResult.status === "pass" && build) {
      gates.push(gate("product: bundle, signature, architecture", () => productGate(options, build)));
    }
  }

  const failed = gates.filter((entry) => entry.status === "fail");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    xcode: runSoft("xcodebuild", ["-version"]).stdout.trim(),
    project: options.project,
    scheme: options.scheme,
    configuration: options.configuration,
    sdk: options.sdk,
    gates,
    status: failed.length === 0 ? "pass" : "fail",
  };

  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nreport: ${options.json}\n`);
  }

  process.stdout.write(
    `\n${failed.length === 0 ? "ALL GATES PASSED" : `${failed.length} GATE(S) FAILED`}: ${failed
      .map((entry) => entry.name)
      .join(", ")}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
