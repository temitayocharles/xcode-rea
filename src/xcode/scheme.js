import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseXml, findElement, findElements } from "../plist/index.js";
import { normalizeSlashes } from "../util/text.js";

export class SchemeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SchemeError";
  }
}

function boolAttr(node, name, fallback = false) {
  const value = node?.attrs?.[name];
  if (value === undefined) return fallback;
  return value === "YES" || value === "true" || value === "1";
}

function buildableReference(node) {
  const ref = findElement(node, "BuildableReference");
  if (!ref) return null;
  return {
    buildableIdentifier: ref.attrs.BuildableIdentifier ?? null,
    blueprintIdentifier: ref.attrs.BlueprintIdentifier ?? null,
    buildableName: ref.attrs.BuildableName ?? null,
    blueprintName: ref.attrs.BlueprintName ?? null,
    referencedContainer: ref.attrs.ReferencedContainer ?? null,
  };
}

function testableReference(node) {
  return {
    reference: buildableReference(node),
    skipped: boolAttr(node, "skipped", false),
    parallelizable: boolAttr(node, "parallelizable", true),
    useTestSelectionWhitelist: boolAttr(node, "useTestSelectionWhitelist", false),
  };
}

export function parseScheme(text, path = "<scheme>") {
  const document = parseXml(text);
  const schemeNode = findElement(document, "Scheme");
  if (!schemeNode) throw new SchemeError(`${path} is not an Xcode scheme`);

  const buildAction = findElement(schemeNode, "BuildAction");
  const buildEntries = [];
  if (buildAction) {
    for (const entry of findElements(buildAction, "BuildActionEntry")) {
      buildEntries.push({
        buildForTesting: boolAttr(entry, "buildForTesting", true),
        buildForRunning: boolAttr(entry, "buildForRunning", true),
        buildForProfiling: boolAttr(entry, "buildForProfiling", true),
        buildForArchiving: boolAttr(entry, "buildForArchiving", true),
        buildForAnalyzing: boolAttr(entry, "buildForAnalyzing", true),
        reference: buildableReference(entry),
      });
    }
  }

  const testAction = findElement(schemeNode, "TestAction");
  const testables = testAction
    ? findElements(testAction, "TestableReference").map(testableReference)
    : [];
  const macroExpansion = testAction ? buildableReference(testAction) : null;

  const launchAction = findElement(schemeNode, "LaunchAction");
  const profileAction = findElement(schemeNode, "ProfileAction");
  const analyzeAction = findElement(schemeNode, "AnalyzeAction");
  const archiveAction = findElement(schemeNode, "ArchiveAction");

  return {
    name: basename(path).replace(/\.xcscheme$/, ""),
    path: normalizeSlashes(path),
    version: schemeNode.attrs.version ?? schemeNode.attrs.LastUpgradeVersion ?? null,
    lastUpgradeVersion: schemeNode.attrs.LastUpgradeVersion ?? null,
    build: {
      implicitDependencies: boolAttr(buildAction, "buildImplicitDependencies", true),
      parallelizeBuildables: boolAttr(buildAction, "parallelizeBuildables", true),
      entries: buildEntries,
    },
    test: {
      buildConfiguration: testAction?.attrs.buildConfiguration ?? "Debug",
      selectedDebuggerIdentifier: testAction?.attrs.selectedDebuggerIdentifier ?? null,
      selectedLauncherIdentifier: testAction?.attrs.selectedLauncherIdentifier ?? null,
      shouldUseLaunchSchemeArgsEnv: boolAttr(testAction, "shouldUseLaunchSchemeArgsEnv", true),
      testables,
      macroExpansion,
    },
    launch: {
      buildConfiguration: launchAction?.attrs.buildConfiguration ?? "Debug",
      launchStyle: launchAction?.attrs.launchStyle ?? "0",
      useCustomWorkingDirectory: boolAttr(launchAction, "useCustomWorkingDirectory", false),
      ignoresPersistentStateOnLaunch: boolAttr(launchAction, "ignoresPersistentStateOnLaunch", false),
      debugDocumentVersioning: boolAttr(launchAction, "debugDocumentVersioning", true),
      debugServiceExtension: launchAction?.attrs.debugServiceExtension ?? "internal",
      allowLocationSimulation: boolAttr(launchAction, "allowLocationSimulation", true),
      buildableProductRunnable: launchAction
        ? buildableReference(findElement(launchAction, "BuildableProductRunnable") ?? launchAction)
        : null,
    },
    profile: {
      buildConfiguration: profileAction?.attrs.buildConfiguration ?? "Release",
      shouldUseLaunchSchemeArgsEnv: boolAttr(profileAction, "shouldUseLaunchSchemeArgsEnv", true),
      buildableProductRunnable: profileAction
        ? buildableReference(findElement(profileAction, "BuildableProductRunnable") ?? profileAction)
        : null,
    },
    analyze: {
      buildConfiguration: analyzeAction?.attrs.buildConfiguration ?? "Debug",
    },
    archive: {
      buildConfiguration: archiveAction?.attrs.buildConfiguration ?? "Release",
      revealArchiveInOrganizer: boolAttr(archiveAction, "revealArchiveInOrganizer", true),
    },
  };
}

export function loadScheme(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SchemeError(`cannot read scheme ${path}: ${error.message}`, { cause: error });
  }
  return parseScheme(text, path);
}

const ACTION_BUILD_FLAGS = {
  build: "buildForRunning",
  test: "buildForTesting",
  profile: "buildForProfiling",
  archive: "buildForArchiving",
  analyze: "buildForAnalyzing",
  run: "buildForRunning",
};

export function schemeEntriesForAction(scheme, action = "build") {
  const flag = ACTION_BUILD_FLAGS[action] ?? "buildForRunning";
  return scheme.build.entries.filter((entry) => entry[flag]);
}

export function schemeBlueprintIds(scheme, action = "build") {
  return schemeEntriesForAction(scheme, action)
    .map((entry) => entry.reference?.blueprintIdentifier)
    .filter(Boolean);
}

export function schemeConfiguration(scheme, action = "build") {
  switch (action) {
    case "test":
      return scheme.test.buildConfiguration;
    case "profile":
      return scheme.profile.buildConfiguration;
    case "analyze":
      return scheme.analyze.buildConfiguration;
    case "archive":
      return scheme.archive.buildConfiguration;
    default:
      return scheme.launch.buildConfiguration;
  }
}
