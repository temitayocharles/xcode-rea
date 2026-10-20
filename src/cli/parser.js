/**
 * Argument parsing that accepts both xcodebuild's single-dash flags
 * (`-project`, `-scheme`, `-showBuildSettings`) and GNU-style flags
 * (`--project`, `--json`).
 */

const BOOLEAN_FLAGS = new Set([
  "json",
  "quiet",
  "verbose",
  "dry-run",
  "list",
  "showbuildsettings",
  "showdestinations",
  "alltargets",
  "help",
  "version",
  "allowprovisioningupdates",
  "disableautomaticpackageresolution",
  "skippackagepluginvalidation",
  "skipmacrovalidation",
  "enablecodecoverage",
  "usepackagesupportbuiltinscm",
  "nocolor",
  "plan",
]);

const VALUE_FLAGS = new Set([
  "project",
  "workspace",
  "scheme",
  "target",
  "configuration",
  "sdk",
  "destination",
  "deriveddatapath",
  "arch",
  "xcconfig",
  "toolchain",
  "resultbundlepath",
  "jobs",
  "only-testing",
  "onlytesting",
  "skip-testing",
  "skiptesting",
  "testplan",
  "destination-timeout",
  "destinationtimeout",
  "xcode",
  "out",
  "port",
  "host",
  "provider",
  "profile",
  "device",
]);

export const COMMANDS = new Set([
  "build",
  "clean",
  "list",
  "show-build-settings",
  "showbuildsettings",
  "doctor",
  "spec",
  "rea",
  "compat",
  "studio",
  "version",
  "help",
  "xcodebuild",
  "analyze",
  "archive",
  "test",
  "run",
  "install",
  "capabilities",
  "destinations",
  "showdestinations",
]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function normalizeFlag(name) {
  return name.toLowerCase().replace(/-/g, "");
}

function splitFlag(arg, prefixLength) {
  const body = arg.slice(prefixLength);
  const equals = body.indexOf("=");
  if (equals === -1) return { name: body, value: null };
  return { name: body.slice(0, equals), value: body.slice(equals + 1) };
}

/**
 * @param {string[]} argv
 */
export function parseArgv(argv) {
  const input = [...argv];
  const values = {};
  const flags = new Set();
  const overrides = {};
  const positionals = [];
  let command = null;

  if (input[0] === "xcodebuild") input.shift();

  if (input.length > 0 && COMMANDS.has(input[0])) {
    command = input.shift();
  }

  const assign = (rawName, value) => {
    const name = normalizeFlag(rawName);
    if (value === null || value === true) {
      if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
        // Unknown switch: accept it as a boolean for forward compatibility.
        flags.add(name);
        return;
      }
      if (VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
        throw new UsageError(`missing value for -${rawName}`);
      }
      flags.add(name);
      return;
    }
    if (name === "target") {
      values.targets = values.targets ?? [];
      values.targets.push(value);
      return;
    }
    if (name === "onlytesting" || name === "skiptesting") {
      const key = name;
      values[key] = values[key] ?? [];
      values[key].push(value);
      return;
    }
    values[name] = value;
  };

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === "--") {
      positionals.push(...input.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const { name, value } = splitFlag(arg, 2);
      if (value !== null) {
        assign(name, value);
        continue;
      }
      const normalized = normalizeFlag(name);
      if (BOOLEAN_FLAGS.has(normalized)) {
        assign(name, true);
        continue;
      }
      const next = input[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        assign(name, next);
        i += 1;
      } else {
        assign(name, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && /^[A-Za-z]/.test(arg[1])) {
      const { name, value } = splitFlag(arg, 1);
      const normalized = normalizeFlag(name);
      if (value !== null) {
        assign(name, value);
        continue;
      }
      if (BOOLEAN_FLAGS.has(normalized)) {
        assign(name, true);
        continue;
      }
      const next = input[i + 1];
      if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
        assign(name, next);
        i += 1;
      } else if (VALUE_FLAGS.has(normalized)) {
        throw new UsageError(`missing value for -${name}`);
      } else {
        assign(name, true);
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      const equals = arg.indexOf("=");
      overrides[arg.slice(0, equals)] = arg.slice(equals + 1);
      continue;
    }
    positionals.push(arg);
  }

  if (command === null) {
    const index = positionals.findIndex((entry) => COMMANDS.has(entry));
    if (index !== -1) {
      command = positionals[index];
      positionals.splice(index, 1);
    }
  }

  return {
    command,
    values,
    flags,
    overrides,
    positionals,
    has: (name) => flags.has(normalizeFlag(name)),
    get: (name) => values[normalizeFlag(name)],
  };
}

export function resolveCommand(parsed) {
  if (parsed.command === "xcodebuild") {
    if (parsed.has("list")) return "list";
    if (parsed.has("showbuildsettings")) return "show-build-settings";
    if (parsed.has("showdestinations")) return "destinations";
    return "build";
  }
  if (parsed.command) return parsed.command;
  if (parsed.has("list")) return "list";
  if (parsed.has("showbuildsettings")) return "show-build-settings";
  if (parsed.has("showdestinations")) return "destinations";
  if (parsed.has("version")) return "version";
  if (parsed.positionals.length > 0) {
    throw new UsageError(`unknown command: ${parsed.positionals[0]}`);
  }
  const buildInput =
    parsed.get("project") ??
    parsed.get("workspace") ??
    parsed.get("scheme") ??
    parsed.values.targets?.[0];
  if (buildInput) return "build";
  return "help";
}
