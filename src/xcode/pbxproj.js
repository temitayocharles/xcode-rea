import { readdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseOpenStep, stringifyOpenStep } from "../plist/index.js";
import { joinPath, normalizeSlashes } from "../util/text.js";

export class ProjectError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProjectError";
  }
}

const GROUP_ISAS = new Set([
  "PBXGroup",
  "PBXVariantGroup",
  "XCVersionGroup",
  "PBXFileSystemSynchronizedRootGroup",
  "PBXFileSystemSynchronizedGroup",
]);

const BUNDLE_EXTENSIONS = new Set([
  ".xcassets",
  ".storyboard",
  ".xib",
  ".bundle",
  ".scnassets",
  ".framework",
  ".xcframework",
  ".mlmodelc",
  ".rcproject",
  ".playground",
  ".docc",
  ".app",
  ".appex",
  ".xctest",
  ".xpc",
]);

const SOURCE_EXTENSIONS = new Set([
  ".swift",
  ".m",
  ".mm",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".s",
  ".S",
  ".metal",
  ".iig",
]);

const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".ipp", ".tpp"]);

export function isSourceFile(path) {
  return SOURCE_EXTENSIONS.has(extname(path)) || SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isHeaderFile(path) {
  return HEADER_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isBundlePath(path) {
  return BUNDLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Resolve a `sourceTree` + relative path pair into an absolute or symbolic path.
 * Build-setting variables are preserved for later expansion.
 */
export function resolveSourceTree(sourceTree, parentDir, path) {
  const child = path ?? "";
  switch (sourceTree) {
    case "<absolute>":
      return normalizeSlashes(child);
    case "SOURCE_ROOT":
      return joinPath(parentDir, child);
    case "BUILT_PRODUCTS_DIR":
      return normalizeSlashes(`$(BUILT_PRODUCTS_DIR)/${child}`);
    case "SDKROOT":
      return normalizeSlashes(`$(SDKROOT)/${child}`);
    case "DEVELOPER_DIR":
      return normalizeSlashes(`$(DEVELOPER_DIR)/${child}`);
    case "<group>":
    default:
      return joinPath(parentDir, child);
  }
}

class XcodeProjectFile {
  constructor(raw, path) {
    this.raw = raw;
    this.projectFile = path;
    this.path = path.endsWith("project.pbxproj") ? dirname(path) : path;
    this.projectDir = dirname(this.path);
    this.bundleName = basename(this.path);
    this.objects = raw.objects ?? {};
    this.rootObject = raw.rootObject;
    this.root = this.objects[this.rootObject];
    if (!this.root) {
      throw new ProjectError(`project ${path} has no rootObject`);
    }
    if (!this.objects || typeof this.objects !== "object") {
      throw new ProjectError(`project ${path} has no objects table`);
    }
    this.groupParent = new Map();
    for (const [id, object] of Object.entries(this.objects)) {
      if (!object || typeof object !== "object") continue;
      if (!GROUP_ISAS.has(object.isa) && object.isa !== "PBXProject") continue;
      for (const child of object.children ?? []) this.groupParent.set(child, id);
    }
    this.synchronizedCache = new Map();
  }

  static parse(text, path) {
    const raw = parseOpenStep(text, { source: path });
    if (!raw || typeof raw !== "object") {
      throw new ProjectError(`${path} is not a property-list dictionary`);
    }
    return new XcodeProjectFile(raw, path);
  }

  static load(inputPath) {
    const path = inputPath.endsWith(".pbxproj")
      ? inputPath
      : join(inputPath, "project.pbxproj");
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new ProjectError(`cannot read project file ${path}: ${error.message}`, { cause: error });
    }
    return XcodeProjectFile.parse(text, path);
  }

  object(id) {
    return this.objects[id];
  }

  get name() {
    let base = basename(this.path);
    if (base.endsWith(".pbxproj")) base = base.slice(0, -".pbxproj".length);
    base = base.replace(/\.xcodeproj$/, "");
    if (base === "project" || base === "") base = basename(dirname(this.path));
    return base;
  }

  get objectVersion() {
    return this.root.objectVersion ?? this.raw.objectVersion;
  }

  get archiveVersion() {
    return this.raw.archiveVersion;
  }

  get compatibilityVersion() {
    return this.root.compatibilityVersion;
  }

  get lastUpgradeCheck() {
    return this.root.lastUpgradeCheck;
  }

  get developmentRegion() {
    return this.root.developmentRegion;
  }

  get knownRegions() {
    return this.root.knownRegions ?? [];
  }

  configurationList(listId) {
    const list = this.objects[listId];
    if (!list) return { configurations: [], defaultConfigurationName: null };
    const configurations = (list.buildConfigurations ?? [])
      .map((id) => {
        const config = this.objects[id];
        if (!config) return null;
        return {
          id,
          name: config.name,
          buildSettings: config.buildSettings ?? {},
          baseConfigurationReference: config.baseConfigurationReference ?? null,
        };
      })
      .filter(Boolean);
    return {
      id: listId,
      defaultConfigurationName: list.defaultConfigurationName ?? configurations[0]?.name ?? null,
      configurations,
    };
  }

  projectConfigurations() {
    return this.configurationList(this.root.buildConfigurationList);
  }

  targetConfigurations(targetId) {
    const target = this.objects[targetId];
    return this.configurationList(target?.buildConfigurationList);
  }

  configurationNames() {
    return this.projectConfigurations().configurations.map((config) => config.name);
  }

  defaultConfigurationName() {
    return this.projectConfigurations().defaultConfigurationName ?? "Release";
  }

  targetIds() {
    return this.root.targets ?? [];
  }

  target(id) {
    const object = this.objects[id];
    if (!object) return null;
    return {
      id,
      isa: object.isa,
      name: object.name ?? object.productName ?? id,
      productName: object.productName ?? object.name ?? id,
      productType: object.productType ?? null,
      productReference: object.productReference ?? null,
      buildConfigurationList: object.buildConfigurationList ?? null,
      buildPhases: object.buildPhases ?? [],
      dependencies: object.dependencies ?? [],
      fileSystemSynchronizedGroups: object.fileSystemSynchronizedGroups ?? [],
      packageProductDependencies: object.packageProductDependencies ?? [],
      buildRules: object.buildRules ?? [],
      object,
    };
  }

  targets() {
    return this.targetIds()
      .map((id) => this.target(id))
      .filter(Boolean)
      .filter((target) => target.isa === "PBXNativeTarget" || target.isa === "PBXAggregateTarget" || target.isa === "PBXLegacyTarget");
  }

  targetByName(name) {
    return this.targets().find((target) => target.name === name) ?? null;
  }

  /** Directory of a group, as an absolute or symbolic path. */
  directoryForGroup(groupId) {
    const ref = this.objects[groupId];
    if (!ref || ref.isa === "PBXProject") return this.projectDir;
    const parentId = this.groupParent.get(groupId);
    let base;
    switch (ref.sourceTree) {
      case "<absolute>":
        base = "";
        break;
      case "SOURCE_ROOT":
        base = this.projectDir;
        break;
      case "BUILT_PRODUCTS_DIR":
        base = "$(BUILT_PRODUCTS_DIR)";
        break;
      case "SDKROOT":
        base = "$(SDKROOT)";
        break;
      case "DEVELOPER_DIR":
        base = "$(DEVELOPER_DIR)";
        break;
      case "<group>":
      default:
        base = parentId ? this.directoryForGroup(parentId) : this.projectDir;
        break;
    }
    return ref.path ? joinPath(base, ref.path) : base;
  }

  /** Absolute (or symbolic) path for a PBXFileReference. */
  resolveReferencePath(referenceId) {
    const ref = this.objects[referenceId];
    if (!ref) return null;
    if (ref.isa === "PBXVariantGroup") return null;
    const base = this.baseDirectoryFor(ref, referenceId);
    return resolveSourceTree(ref.sourceTree, base, ref.path ?? ref.name ?? "");
  }

  /**
   * A reference's own `sourceTree` decides its base. Only `<group>` (the
   * default) walks up to the containing group; SOURCE_ROOT and the symbolic
   * trees are resolved against the project or the build environment.
   */
  baseDirectoryFor(ref, referenceId) {
    switch (ref.sourceTree) {
      case "SOURCE_ROOT":
        return this.projectDir;
      case "<absolute>":
        return "";
      case "BUILT_PRODUCTS_DIR":
      case "SDKROOT":
      case "DEVELOPER_DIR":
        return "";
      case "<group>":
      default: {
        const parentId = this.groupParent.get(referenceId);
        return parentId ? this.directoryForGroup(parentId) : this.projectDir;
      }
    }
  }

  relativePathFor(referenceId) {
    const object = this.objects[referenceId];
    if (!object) return null;
    if (object.isa === "PBXVariantGroup") {
      return object.name ?? object.path ?? referenceId;
    }
    const base = this.baseDirectoryFor(object, referenceId);
    return object.path ? joinPath(base, object.path) : object.name ?? referenceId;
  }

  productPath(targetId) {
    const target = this.target(targetId);
    if (!target?.productReference) return null;
    return this.resolveReferencePath(target.productReference);
  }

  buildPhases(targetId, isa) {
    const target = this.target(targetId);
    if (!target) return [];
    return target.buildPhases
      .map((id) => ({ id, ...this.objects[id] }))
      .filter((phase) => phase.isa && (!isa || phase.isa === isa));
  }

  expandBuildFile(buildFileId) {
    const buildFile = this.objects[buildFileId];
    if (!buildFile) return [];
    const referenceId = buildFile.fileRef ?? buildFile.productRef;
    if (!referenceId) return [];
    const reference = this.objects[referenceId];
    if (!reference) return [];
    const compilerFlags = buildFile.settings?.COMPILER_FLAGS ?? null;
    if (reference.isa === "PBXVariantGroup" || reference.isa === "XCVersionGroup") {
      return (reference.children ?? []).map((childId) => {
        const child = this.objects[childId];
        return {
          buildFileId,
          referenceId: childId,
          path: this.resolveReferencePath(childId),
          name: reference.name ?? child?.name,
          region: child?.name ?? null,
          compilerFlags,
          platformFilters: buildFile.platformFilters ?? null,
        };
      });
    }
    return [
      {
        buildFileId,
        referenceId,
        path: this.resolveReferencePath(referenceId),
        name: reference.name ?? basename(reference.path ?? ""),
        region: null,
        compilerFlags,
        platformFilters: buildFile.platformFilters ?? null,
      },
    ];
  }

  sources(targetId) {
    const entries = [];
    for (const phase of this.buildPhases(targetId, "PBXSourcesBuildPhase")) {
      for (const buildFileId of phase.files ?? []) {
        for (const entry of this.expandBuildFile(buildFileId)) {
          if (!entry.path) continue;
          entries.push({ ...entry, origin: "phase", phaseId: phase.id });
        }
      }
    }
    entries.push(...this.synchronizedEntries(targetId, "sources"));
    return dedupeBy(entries, (entry) => entry.path);
  }

  resources(targetId) {
    const entries = [];
    for (const phase of this.buildPhases(targetId, "PBXResourcesBuildPhase")) {
      for (const buildFileId of phase.files ?? []) {
        for (const entry of this.expandBuildFile(buildFileId)) {
          if (!entry.path) continue;
          entries.push({
            ...entry,
            origin: "phase",
            phaseId: phase.id,
            kind: resourceKind(entry.path, entry.name),
          });
        }
      }
    }
    entries.push(...this.synchronizedEntries(targetId, "resources"));
    return dedupeBy(entries, (entry) => entry.path);
  }

  headers(targetId) {
    const entries = [];
    for (const phase of this.buildPhases(targetId, "PBXHeadersBuildPhase")) {
      for (const buildFileId of phase.files ?? []) {
        const buildFile = this.objects[buildFileId];
        for (const entry of this.expandBuildFile(buildFileId)) {
          if (!entry.path) continue;
          entries.push({
            ...entry,
            visibility: buildFile?.settings?.ATTRIBUTES ?? [],
          });
        }
      }
    }
    return entries;
  }

  frameworks(targetId) {
    const entries = [];
    for (const phase of this.buildPhases(targetId, "PBXFrameworksBuildPhase")) {
      for (const buildFileId of phase.files ?? []) {
        for (const entry of this.expandBuildFile(buildFileId)) {
          if (!entry.path) continue;
          entries.push({
            ...entry,
            framework: frameworkName(entry.path),
            linkKind: linkKindFor(entry.path),
          });
        }
      }
    }
    return dedupeBy(entries, (entry) => entry.path);
  }

  copyFiles(targetId) {
    const entries = [];
    for (const phase of this.buildPhases(targetId, "PBXCopyFilesBuildPhase")) {
      for (const buildFileId of phase.files ?? []) {
        for (const entry of this.expandBuildFile(buildFileId)) {
          if (!entry.path) continue;
          entries.push({
            ...entry,
            destination: copyDestination(phase.dstSubfolderSpec, phase.dstPath),
            phaseName: phase.name ?? "",
          });
        }
      }
    }
    return entries;
  }

  shellScripts(targetId) {
    return this.buildPhases(targetId, "PBXShellScriptBuildPhase").map((phase) => ({
      id: phase.id,
      name: phase.name ?? "Run Script",
      script: phase.shellScript ?? "",
      shellPath: phase.shellPath ?? "/bin/sh",
      inputPaths: phase.inputPaths ?? [],
      outputPaths: phase.outputPaths ?? [],
      inputFileListPaths: phase.inputFileListPaths ?? [],
      outputFileListPaths: phase.outputFileListPaths ?? [],
      alwaysOutOfDate: String(phase.alwaysOutOfDate ?? "0") === "1",
      runOnlyForDeploymentPostprocessing:
        String(phase.runOnlyForDeploymentPostprocessing ?? "0") === "1",
    }));
  }

  dependencies(targetId) {
    const target = this.target(targetId);
    if (!target) return [];
    const results = [];
    for (const dependencyId of target.dependencies) {
      const dependency = this.objects[dependencyId];
      if (!dependency) continue;
      const proxy = dependency.targetProxy ? this.objects[dependency.targetProxy] : null;
      const remoteId = proxy?.remoteGlobalIDString ?? dependency.target;
      const remote = remoteId ? this.target(remoteId) : null;
      results.push({
        id: dependencyId,
        targetId: remoteId ?? null,
        name: remote?.name ?? dependency.name ?? proxy?.remoteInfo ?? "unknown",
        proxy,
      });
    }
    return results;
  }

  /** All file references reachable from groups, with their logical group path. */
  fileTree() {
    const walk = (groupId, prefix) => {
      const group = this.objects[groupId];
      if (!group) return [];
      const groupPath = group.path ? joinPath(prefix, group.path) : prefix;
      const rows = [];
      for (const childId of group.children ?? []) {
        const child = this.objects[childId];
        if (!child) continue;
        if (GROUP_ISAS.has(child.isa)) {
          rows.push({
            id: childId,
            name: child.name ?? child.path ?? childId,
            path: child.path ? joinPath(prefix, child.path) : prefix,
            isa: child.isa,
            isGroup: true,
            children: walk(childId, groupPath),
          });
        } else {
          rows.push({
            id: childId,
            name: child.name ?? basename(child.path ?? ""),
            path: child.path ? joinPath(groupPath, child.path) : groupPath,
            isa: child.isa,
            isGroup: false,
            fileType: child.lastKnownFileType ?? null,
          });
        }
      }
      return rows;
    };
    const detail = this.objects[this.root.mainGroup];
    if (!detail) return [];
    return detail.children ? walk(this.root.mainGroup, "") : [];
  }

  synchronizedEntries(targetId, kind) {
    const cacheKey = `${targetId}:${kind}`;
    if (this.synchronizedCache.has(cacheKey)) return this.synchronizedCache.get(cacheKey);
    const target = this.target(targetId);
    const entries = [];
    if (target) {
      for (const groupId of target.fileSystemSynchronizedGroups) {
        const group = this.objects[groupId];
        if (!group) continue;
        const root = this.directoryForGroup(groupId);
        const rules = this.synchronizedRules(group, targetId);
        for (const file of walkDirectory(root)) {
          const relative = file.slice(root.length).replace(/^\/+/, "");
          if (rules.excluded.has(relative)) continue;
          if (file.endsWith("Info.plist")) continue;
          if (kind === "sources" && isSourceFile(file)) {
            entries.push({
              buildFileId: null,
              referenceId: null,
              path: file,
              relativePath: relative,
              name: basename(file),
              compilerFlags: rules.compilerFlags.get(relative) ?? null,
              origin: "synchronized",
              groupId,
            });
          } else if (kind === "resources" && !isSourceFile(file) && !isHeaderFile(file)) {
            entries.push({
              buildFileId: null,
              referenceId: null,
              path: file,
              relativePath: relative,
              name: basename(file),
              origin: "synchronized",
              groupId,
              kind: resourceKind(file, basename(file)),
            });
          }
        }
      }
    }
    this.synchronizedCache.set(cacheKey, entries);
    return entries;
  }

  synchronizedRules(group, targetId) {
    const excluded = new Set();
    const compilerFlags = new Map();
    for (const exceptionId of group.exceptions ?? []) {
      const exception = this.objects[exceptionId];
      if (!exception) continue;
      if (exception.target && exception.target !== targetId) continue;
      for (const path of exception.membershipExceptions ?? []) excluded.add(normalizeSlashes(path));
      for (const [path, flags] of Object.entries(exception.additionalCompilerFlagsByRelativePath ?? {})) {
        compilerFlags.set(normalizeSlashes(path), flags);
      }
    }
    return { excluded, compilerFlags };
  }

  /** Serialize back to the OpenStep pbxproj format. */
  serialize() {
    return stringifyOpenStep(this.raw, { header: true });
  }

  toJSON() {
    return {
      name: this.name,
      path: this.path,
      objectVersion: this.objectVersion,
      compatibilityVersion: this.compatibilityVersion,
      targets: this.targets().map((target) => ({
        id: target.id,
        name: target.name,
        isa: target.isa,
        productType: target.productType,
        productPath: this.productPath(target.id),
      })),
      configurations: this.configurationNames(),
      defaultConfiguration: this.defaultConfigurationName(),
    };
  }
}

function dedupeBy(entries, keyFn) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = keyFn(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function walkDirectory(root) {
  if (/^\$[({]/.test(root)) return [];
  const results = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isBundlePath(full)) {
          results.push(full);
        } else {
          visit(full);
        }
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  visit(root);
  return results;
}

export function resourceKind(path, name = "") {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".xcassets":
      return "asset-catalog";
    case ".storyboard":
      return "storyboard";
    case ".xib":
      return "xib";
    case ".strings":
    case ".stringsdict":
      return "strings";
    case ".plist":
      return "plist";
    case ".scnassets":
      return "scene-assets";
    case ".mlmodel":
    case ".mlmodelc":
      return "coreml";
    case ".docc":
      return "documentation";
    default:
      return "copy";
  }
}

export function frameworkName(path) {
  const match = /([^/]+)\.(framework|xcframework)(?:\/|$)/.exec(path);
  if (match) return match[1];
  const name = basename(path);
  return name.replace(/\.(framework|xcframework|tbd|dylib|a)$/i, "");
}

export function linkKindFor(path) {
  if (/\.xcframework\/?$/.test(path)) return "xcframework";
  if (/\.framework\/?$/.test(path)) return "framework";
  if (/\.(tbd|dylib)$/.test(path)) return "dylib";
  if (/\.a$/.test(path)) return "static-library";
  return "other";
}

export function copyDestination(spec, dstPath) {
  switch (Number(spec)) {
    case 0:
      return dstPath || "";
    case 1:
      return "Wrapper";
    case 6:
      return "Executables";
    case 7:
      return "Resources";
    case 10:
      return "Frameworks";
    case 11:
      return "Shared Frameworks";
    case 12:
      return "Shared Support";
    case 13:
      return "PlugIns";
    case 16:
      return "Products";
    case 17:
      return "Java Resources";
    default:
      return dstPath || `subfolder-${spec}`;
  }
}

export function loadProject(path) {
  return XcodeProjectFile.load(path);
}

export function parseProject(text, path) {
  return XcodeProjectFile.parse(text, path);
}

export { XcodeProjectFile };

export function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
