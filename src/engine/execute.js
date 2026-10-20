import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parsePlist, stringifyXmlPlist } from "../plist/index.js";
import { generatedInfoPlist, expandPlistValue } from "./plan.js";

export class BuildError extends Error {
  constructor(message, step, output = "") {
    super(message);
    this.name = "BuildError";
    this.step = step;
    this.output = output;
  }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function runInternal(step, plan) {
  const [command, ...args] = step.command.args;
  switch (command) {
    case "generate-info-plist": {
      const targetPath = args[0];
      ensureDirectory(dirname(targetPath));
      const info = generatedInfoPlist(plan.settings, { name: plan.target.name }, plan.platform);
      writeFileSync(targetPath, stringifyXmlPlist(info));
      return { status: 0, stdout: `wrote ${targetPath}\n`, stderr: "" };
    }
    case "process-info-plist": {
      const [source, destination] = args;
      const value = parsePlist(readFileSync(source));
      const expanded = expandPlistValue(value, plan.settings);
      ensureDirectory(dirname(destination));
      writeFileSync(destination, stringifyXmlPlist(expanded));
      return { status: 0, stdout: `wrote ${destination}\n`, stderr: "" };
    }
    case "write-pkginfo": {
      const destination = args[0];
      ensureDirectory(dirname(destination));
      writeFileSync(destination, "APPL????");
      return { status: 0, stdout: "", stderr: "" };
    }
    default:
      throw new BuildError(`unknown internal build command: ${command}`, step);
  }
}

const MACOS_ONLY_TOOLS = new Set(["xcrun", "codesign", "actool", "ibtool", "plutil", "metal", "metallib"]);

/**
 * Execute a plan. With `dryRun` nothing is spawned and nothing is written;
 * the returned structure still reports every planned command.
 */
export function executePlan(plan, options = {}) {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;
  const quiet = options.quiet === true;
  const write = options.write ?? ((line) => process.stdout.write(line));
  const writeError = options.writeError ?? ((line) => process.stderr.write(line));
  const env = {
    ...process.env,
    ...(plan.settings?.DEVELOPER_DIR ? { DEVELOPER_DIR: plan.settings.DEVELOPER_DIR } : {}),
    ...(plan.settings?.SDKROOT ? { SDKROOT: plan.settings.SDKROOT } : {}),
    ...(options.env ?? {}),
  };
  const total = plan.steps.length;
  const results = [];

  plan.steps.forEach((step, index) => {
    const prefix = `[${index + 1}/${total}]`;
    if (!quiet) {
      write(`${prefix} ${step.title}\n`);
      if (dryRun || verbose) {
        write(`      ${step.display}\n`);
        if (step.description) write(`      (${step.description})\n`);
      }
    } else if (dryRun) {
      write(`${step.display}\n`);
    }

    if (dryRun) {
      results.push({ step, status: 0, dryRun: true });
      return;
    }

    const started = Date.now();
    let result;
    if (step.command.tool === "xcl-internal") {
      try {
        result = runInternal(step, plan);
      } catch (error) {
        if (error instanceof BuildError) throw error;
        throw new BuildError(error.message, step);
      }
    } else {
      if (process.platform !== "darwin" && MACOS_ONLY_TOOLS.has(step.command.tool)) {
        throw new BuildError(
          `cannot execute ${step.command.tool} on ${process.platform}; builds require macOS with Xcode or Command Line Tools`,
          step,
        );
      }
      result = spawnSync(step.command.tool, step.command.args, {
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error) {
        throw new BuildError(
          `failed to launch ${step.command.tool}: ${result.error.message}`,
          step,
        );
      }
      if (verbose && result.stdout) write(result.stdout);
      if (verbose && result.stderr) writeError(result.stderr);
    }

    const durationMs = Date.now() - started;
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new BuildError(
        `${step.title} failed with exit code ${result.status}\n${output}`,
        step,
        output,
      );
    }
    results.push({ step, status: 0, durationMs });
  });

  return { results, dryRun, env };
}

export function summarizePlan(plan) {
  const counts = {};
  for (const step of plan.steps) counts[step.kind] = (counts[step.kind] ?? 0) + 1;
  return {
    target: plan.target.name,
    product: plan.target.productPath,
    steps: plan.steps.length,
    counts,
  };
}
