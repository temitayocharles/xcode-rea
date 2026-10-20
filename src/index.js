/**
 * Public library surface for xcl.
 *
 * The CLI is the primary product, but the parsers and resolver are usable on
 * their own for tooling that needs Xcode project semantics without Xcode.
 */
export { main, USAGE } from "./cli.js";
export { parsePlist, stringifyXmlPlist, stringifyOpenStep } from "./plist/index.js";
export {
  loadProject,
  parseProject,
  XcodeProjectFile,
  ProjectError,
  isSourceFile,
  resourceKind,
} from "./xcode/pbxproj.js";
export { parseXcconfig, readXcconfig, parseConditionalKey, XcconfigError } from "./xcode/xcconfig.js";
export { parseScheme, loadScheme, schemeBlueprintIds, schemeConfiguration } from "./xcode/scheme.js";
export { Workspace, WorkspaceError, findSchemes } from "./xcode/workspace.js";
export { resolveBuildSettings, expandSettings, getSetting, splitSettingList } from "./settings/resolver.js";
export { genericDefaults, defaultDerivedDataPath } from "./settings/defaults.js";
export { productTypeInfo, PRODUCT_TYPES } from "./settings/productTypes.js";
export { detectToolchain, resolveSdk, listSdks } from "./settings/toolchain.js";
export { loadXcodeSpecDefaults, parseSpecFile } from "./settings/spec.js";
export { xcodeVersionSettings } from "./settings/defaults.js";
export {
  planBuild,
  planTarget,
  orderTargets,
  generatedInfoPlist,
  expandPath,
  resolveProjectFile,
} from "./build/plan.js";
export { executePlan, summarizePlan, BuildError } from "./build/execute.js";
export { buildReaPlan } from "./rea/plan.js";
export { extractEvidence, mergeEvidence } from "./rea/import.js";
