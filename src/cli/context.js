import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadProject } from "../xcode/pbxproj.js";
import { Workspace, findSchemes } from "../xcode/workspace.js";
import { loadScheme, schemeBlueprintIds, schemeConfiguration, schemeEntriesForAction } from "../xcode/scheme.js";
import { detectToolchain, resolveSdk } from "../settings/toolchain.js";
import { defaultDerivedDataPath } from "../settings/defaults.js";
import { resolveBuildSettings } from "../settings/resolver.js";
import { loadXcodeSpecDefaults } from "../settings/spec.js";
import { UsageError } from "./parser.js";

const PLATFORM_DIRECTORY = {
  iphoneos: "iPhoneOS platform",
  iphonesimulator: "iOS Simulator",
  macosx: "macOS",
  appletvos: "tvOS",
  appletvsimulator: "tvOS Simulator",
  watchos: "watchOS",
  watchsimulator: "watchOS Simulator",
  xros: "visionOS",
  xrsimulator: "visionOS Simulator",
};

export function platformFromSdkName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("iphonesimulator")) return "iphonesimulator";
  if (lower.startsWith("iphoneos")) return "iphoneos";
  if (lower.startsWith("macosx")) return "macosx";
  if (lower.startsWith("appletvsimulator")) return "appletvsimulator";
  if (lower.startsWith("appletvos")) return "appletvos";
  if (lower.startsWith("watchsimulator")) return "watchsimulator";
  if (lower.startsWith("watchos")) return "watchos";
  if (lower.startsWith("xrsimulator")) return "xrsimulator";
  if (lower.startsWith("xros")) return "xros";
  return null;
}

export function parseDestination(destination) {
  if (!destination) return null;
  const parts = {};
  for (const segment of destination.split(",")) {
    const equals = segment.indexOf("=");
    if (equals === -1) continue;
    parts[segment.slice(0, equals).trim()] = segment.slice(equals + 1).trim();
  }
  const raw = (parts.platform ?? "").toLowerCase();
  let platform = null;
  if (raw.includes("simulator")) {
    if (raw.includes("ios")) platform = "iphonesimulator";
    else if (raw.includes("tvos")) platform = "appletvsimulator";
    else if (raw.includes("watchos")) platform = "watchsimulator";
    else if (raw.includes("visionos") || raw.includes("xros")) platform = "xrsimulator";
  } else if (raw.includes("ios")) {
    platform = "iphoneos";
  } else if (raw.includes("macos") || raw.includes("os x")) {
    platform = "macosx";
  } else if (raw.includes("tvos")) {
    platform = "appletvos";
  } else if (raw.includes("watchos")) {
    platform = "watchos";
  } else if (raw.includes("visionos") || raw.includes("xros")) {
    platform = "xros";
  }
  return {
    platform,
    name: parts.name ?? parts.id ?? null,
    os: parts.OS ?? parts.os ?? null,
    arch: parts.arch ?? parts.architecture ?? null,
    generic: Boolean(parts.generic),
    raw: destination,
    parts,
  };
}

export function findDefaultProjectPath(cwd = process.cwd()) {
  const entries = readdirSync(cwd).filter((name) => name.endsWith(".xcodeproj"));
  if (entries.length === 1) return resolve(cwd, entries[0]);
  if (entries.length > 1) {
    throw new UsageError(
      `multiple projects found in ${cwd}; pass -project (${entries.join(", ")})`,
    );
  }
  return null;
}

export function loadProjects(parsed, cwd = process.cwd()) {
  const workspaceArg = parsed.get("workspace");
  const projectArg = parsed.get("project");

  if (workspaceArg) {
    const workspacePath = resolve(cwd, workspaceArg);
    if (!existsSync(workspacePath)) {
      throw new UsageError(`workspace not found: ${workspacePath}`);
    }
    const workspace = Workspace.load(workspacePath);
    const projects = workspace.projects().map((entry) => {
      if (!existsSync(entry.path)) {
        throw new UsageError(`workspace references missing project: ${entry.path}`);
      }
      return loadProject(entry.path);
    });
    if (projects.length === 0) {
      throw new UsageError(`workspace ${workspacePath} does not reference any projects`);
    }
    return { workspace, workspacePath, projects, primaryProject: projects[0] };
  }

  if (projectArg) {
    const projectPath = resolve(cwd, projectArg);
    if (!existsSync(projectPath)) {
      throw new UsageError(`project not found: ${projectPath}`);
    }
    const project = loadProject(projectPath);
    return { workspace: null, workspacePath: null, projects: [project], primaryProject: project };
  }

  const defaultPath = findDefaultProjectPath(cwd);
  if (!defaultPath) {
    throw new UsageError("no .xcodeproj found; pass -project PATH or -workspace PATH");
  }
  const project = loadProject(defaultPath);
  return { workspace: null, workspacePath: null, projects: [project], primaryProject: project };
}

export function allSchemes(context) {
  const containers = [];
  if (context.workspacePath) containers.push(context.workspacePath);
  for (const project of context.projects) containers.push(project.path);
  const seen = new Set();
  const schemes = [];
  for (const container of containers) {
    for (const scheme of findSchemes(container)) {
      const key = `${scheme.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      schemes.push(scheme);
    }
  }
  return schemes;
}

export function loadSchemeByName(context, name) {
  const scheme = allSchemes(context).find((entry) => entry.name === name);
  if (!scheme) {
    const available = allSchemes(context).map((entry) => entry.name);
    throw new UsageError(
      `scheme "${name}" not found${available.length ? ` (available: ${available.join(", ")})` : ""}`,
    );
  }
  return loadScheme(scheme.path);
}

export function selectTargets(parsed, context, scheme, action = "build") {
  const targetNames = parsed.values.targets ?? [];
  if (targetNames.length > 0) {
    const selected = [];
    for (const name of targetNames) {
      let match = null;
      for (const project of context.projects) {
        const target = project.targetByName(name);
        if (target) {
          match = { project, target };
          break;
        }
      }
      if (!match) {
        const available = context.projects.flatMap((project) =>
          project.targets().map((target) => target.name),
        );
        throw new UsageError(
          `target "${name}" not found${available.length ? ` (available: ${available.join(", ")})` : ""}`,
        );
      }
      selected.push(match);
    }
    return selected;
  }

  if (scheme) {
    const ids = schemeBlueprintIds(scheme, action);
    const selected = [];
    for (const id of ids) {
      for (const project of context.projects) {
        const target = project.target(id);
        if (target) {
          selected.push({ project, target });
          break;
        }
      }
    }
    if (selected.length > 0) return selected;
  }

  if (parsed.has("alltargets")) {
    return context.projects.flatMap((project) =>
      project.targets().map((target) => ({ project, target })),
    );
  }

  const first = context.primaryProject.targets()[0];
  if (!first) {
    throw new UsageError(`project ${context.primaryProject.name} does not define any targets`);
  }
  return [{ project: context.primaryProject, target: first }];
}

export function inferPlatform(context, targets, configuration) {
  for (const { project, target } of targets) {
    const list = target ? project.targetConfigurations(target.id) : project.projectConfigurations();
    const config = list.configurations.find((entry) => entry.name === configuration);
    const sdkroot = config?.buildSettings?.SDKROOT;
    if (sdkroot) {
      const platform = platformFromSdkName(sdkroot);
      if (platform) return platform;
    }
  }
  return "macosx";
}

export function determineConfiguration(parsed, context, scheme, action = "build") {
  const explicit = parsed.get("configuration");
  if (explicit) {
    const available = [...new Set(context.projects.flatMap((project) => project.configurationNames()))];
    if (available.length > 0 && !available.includes(explicit)) {
      throw new UsageError(
        `configuration "${explicit}" not found (available: ${available.join(", ")})`,
      );
    }
    return explicit;
  }
  if (scheme) {
    const fromScheme = schemeConfiguration(scheme, action);
    if (fromScheme) return fromScheme;
  }
  return context.primaryProject.defaultConfigurationName();
}

export function buildEnvironment(parsed, context, { action = "build", cwd = process.cwd() } = {}) {
  const schemeName = parsed.get("scheme");
  const scheme = schemeName ? loadSchemeByName(context, schemeName) : null;
  const targets = selectTargets(parsed, context, scheme, action);
  const configuration = determineConfiguration(parsed, context, scheme, action);
  const destination = parseDestination(parsed.get("destination"));
  const sdkRequested = parsed.get("sdk");

  let platform =
    destination?.platform ??
    platformFromSdkName(sdkRequested) ??
    inferPlatform(context, targets, configuration);

  let sdkVersion = destination?.os ?? null;
  if (sdkRequested) {
    const versionMatch = /(\d+(?:\.\d+)*)$/.exec(sdkRequested);
    if (versionMatch) sdkVersion = versionMatch[1];
  }

  const toolchain = detectToolchain();
  const sdk = resolveSdk({
    developerDir: toolchain.developerDir,
    platform,
    requested: sdkRequested,
    sdkVersion,
  });

  const explicitPlatform = Boolean(destination?.platform || sdkRequested);
  if (!explicitPlatform && sdk?.root) {
    const fromSdk = platformFromSdkName(sdk.root);
    if (fromSdk) platform = fromSdk;
  }

  const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
  const arch = parsed.get("arch") ?? destination?.arch ?? defaultArchFor(platform, hostArch);

  const derivedDataPath = parsed.get("deriveddatapath")
    ? resolve(cwd, parsed.get("deriveddatapath"))
    : defaultDerivedDataPath(context.primaryProject.path);

  const overrides = { ...parsed.overrides };
  if (explicitPlatform && sdk?.root) {
    // Xcode resolves SDKROOT to the selected SDK directory when installed.
    // Retain the symbolic SDK name for offline/portable planning.
    overrides.SDKROOT = sdk.path ?? sdk.root;
  }
  if (parsed.get("arch")) overrides.ARCHS = arch;

  return {
    context,
    scheme,
    schemeName,
    targets,
    configuration,
    destination,
    platform,
    sdk,
    sdkRequested,
    arch,
    hostArch,
    derivedDataPath,
    overrides,
    toolchain,
    action,
    xcconfigPath: parsed.get("xcconfig") ? resolve(cwd, parsed.get("xcconfig")) : null,
  };
}

export function makeSettingsResolver(environment) {
  let specDefaults = null;
  if (environment.toolchain.found && process.env.XCL_SKIP_SPECS !== "1") {
    specDefaults = loadXcodeSpecDefaults({
      developerDir: environment.toolchain.developerDir,
      platforms: [environment.platform],
    }).defaults;
  }
  return (targetModel) => {
    const owningProject =
      environment.context.projects.find((project) =>
        project.targets().some((entry) => entry.id === targetModel.id),
      ) ?? environment.context.primaryProject;
    return resolveBuildSettings({
      project: owningProject,
      target: targetModel,
      configuration: environment.configuration,
      platform: environment.platform,
      sdk: environment.sdk,
      arch: environment.arch,
      hostArch: environment.hostArch,
      derivedDataPath: environment.derivedDataPath,
      developerDir: environment.toolchain.developerDir,
      xcodeVersion: environment.toolchain.version,
      xcodeBuild: environment.toolchain.build,
      overrides: environment.overrides,
      xcconfigPath: environment.xcconfigPath,
      action: environment.action,
      specDefaults,
    });
  };
}

export function defaultArchFor(platform, hostArch) {
  switch (platform) {
    case "iphoneos":
    case "appletvos":
    case "xros":
      return "arm64";
    case "watchos":
      return "arm64_32";
    default:
      // macOS and every simulator build use the host architecture by default.
      return hostArch;
  }
}

export function platformDescription(platform) {
  return PLATFORM_DIRECTORY[platform] ?? platform;
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
