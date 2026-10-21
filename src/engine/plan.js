import { basename, dirname, extname, join } from "node:path";
import { getSetting, splitSettingList } from "../settings/resolver.js";
import { expandSettings } from "../settings/resolver.js";
import { productTypeInfo } from "../settings/productTypes.js";
import { splitShellWords, fileStem } from "../util/text.js";

/**
 * Expand `$(NAME)` / `${NAME}` references in a path using resolved settings.
 * Unknown references are preserved so the resulting command still shows what
 * was missing instead of silently producing a wrong path.
 */
export function expandPath(value, settings) {
  if (!value) return "";
  return String(value).replace(/\$[({]([A-Za-z0-9_]+)[)}]/g, (match, key) =>
    settings[key] !== undefined ? settings[key] : match,
  );
}

/**
 * Settings such as INFOPLIST_FILE and CODE_SIGN_ENTITLEMENTS are project
 * relative: Xcode resolves them against SRCROOT, not the working directory.
 */
export function resolveProjectFile(value, settings) {
  const expanded = expandPath(value, settings);
  if (!expanded) return "";
  if (expanded.startsWith("/") || /^\$[({]/.test(expanded)) return expanded;
  const root = settings.SRCROOT ?? settings.PROJECT_DIR ?? "";
  return root ? join(root, expanded) : expanded;
}

function shellQuote(value) {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Render a command for humans. Only the display is quoted; execution is argv. */
export function formatCommand(command) {
  return [command.tool, ...(command.args ?? [])].map(shellQuote).join(" ");
}

function makeStep({ kind, title, tool, args, inputs = [], outputs = [], description = "" }) {
  const command = { tool, args };
  return {
    kind,
    title,
    description,
    command,
    inputs: inputs.filter(Boolean),
    outputs: outputs.filter(Boolean),
    display: formatCommand(command),
  };
}

const PLATFORM_TRIPLE = {
  iphoneos: "ios",
  iphonesimulator: "ios",
  macosx: "macos",
  appletvos: "tvos",
  appletvsimulator: "tvos",
  watchos: "watchos",
  watchsimulator: "watchos",
  xros: "xros",
  xrsimulator: "xros",
};

const SIMULATOR_PLATFORMS = new Set([
  "iphonesimulator",
  "appletvsimulator",
  "watchsimulator",
  "xrsimulator",
]);

export function targetTriple(platform, arch, deploymentTarget) {
  const os = PLATFORM_TRIPLE[platform] ?? platform;
  const suffix = SIMULATOR_PLATFORMS.has(platform) ? "-simulator" : "";
  const version = String(deploymentTarget ?? "1.0").trim() || "1.0";
  return `${arch}-apple-${os}${version}${suffix}`;
}

function supportedPlatformName(platform) {
  if (platform === "iphonesimulator") return "iPhoneSimulator";
  if (platform === "iphoneos") return "iPhoneOS";
  if (platform === "appletvos" || platform === "appletvsimulator") return "AppleTVOS";
  if (platform === "watchos" || platform === "watchsimulator") return "WatchOS";
  if (platform === "xros" || platform === "xrsimulator") return "XROS";
  return "MacOSX";
}

function coerceInfoValue(value) {
  if (value === "YES" || value === "true") return true;
  if (value === "NO" || value === "false") return false;
  return value;
}

function splitList(value) {
  return String(value)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function plistKeyForSetting(key) {
  if (!key.startsWith("INFOPLIST_KEY_")) return null;
  return key.slice("INFOPLIST_KEY_".length);
}

/**
 * Build an Info.plist from `INFOPLIST_KEY_*` settings, the way Xcode does when
 * GENERATE_INFOPLIST_FILE is enabled.
 */
export function generatedInfoPlist(settings, target, platform) {
  const bundleIdentifier =
    settings.PRODUCT_BUNDLE_IDENTIFIER ||
    `com.xcl.${String(settings.PRODUCT_NAME ?? target.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`;

  const info = {
    CFBundleDevelopmentRegion: settings.DEVELOPMENT_LANGUAGE || "en",
    CFBundleExecutable: settings.EXECUTABLE_NAME,
    CFBundleIdentifier: bundleIdentifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: settings.PRODUCT_NAME,
    CFBundlePackageType: settings.PRODUCT_BUNDLE_PACKAGE_TYPE || "APPL",
    CFBundleShortVersionString: settings.MARKETING_VERSION || "1.0",
    CFBundleSupportedPlatforms: [supportedPlatformName(platform)],
    CFBundleVersion: settings.CURRENT_PROJECT_VERSION || "1",
    DTPlatformName: platform,
  };

  if (platform === "macosx") {
    info.LSMinimumSystemVersion = settings.DEPLOYMENT_TARGET || "10.13";
  } else {
    info.MinimumOSVersion = settings.DEPLOYMENT_TARGET || "1.0";
    info.LSRequiresIPhoneOS = true;
    info.UIDeviceFamily = splitSettingList(settings, "TARGETED_DEVICE_FAMILY")
      .flatMap((value) => value.split(","))
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value));
    info.UISupportedInterfaceOrientations = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
  }

  for (const [key, value] of Object.entries(settings)) {
    const stripped = plistKeyForSetting(key);
    if (!stripped) continue;
    if (stripped.endsWith("_Generation")) {
      const base = stripped.slice(0, -"_Generation".length);
      if (value === "YES" || value === "true") {
        if (base === "UILaunchScreen") info.UILaunchScreen = {};
        if (base === "UIApplicationSceneManifest") {
          info.UIApplicationSceneManifest = { UIApplicationSupportsMultipleScenes: false };
        }
      }
      continue;
    }
    const coerced = coerceInfoValue(value);
    info[stripped] =
      typeof coerced === "string" && stripped.startsWith("UISupportedInterfaceOrientations")
        ? splitList(coerced)
        : coerced;
  }

  if (info.UIDeviceFamily?.length === 1 && info.UIDeviceFamily[0] === 1) {
    delete info.UISupportedInterfaceOrientations;
    info.UISupportedInterfaceOrientations_iPhone = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
  }
  return info;
}

function expandPlistValue(value, settings) {
  if (typeof value === "string") {
    if (!value.includes("$(") && !value.includes("${")) return value;
    const expanded = expandSettings({ ...settings, XCL_EXPAND_VALUE: value });
    return expanded.settings.XCL_EXPAND_VALUE;
  }
  if (Array.isArray(value)) return value.map((item) => expandPlistValue(item, settings));
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandPlistValue(item, settings)]),
    );
  }
  return value;
}

/**
 * Topologically order targets so every dependency is built before its
 * dependants. Input order is preserved for unrelated targets.
 */
export function orderTargets(project, targets) {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const ordered = [];
  const state = new Map();

  const visit = (target, stack) => {
    if (!target) return;
    const status = state.get(target.id);
    if (status === "done") return;
    if (status === "visiting") {
      // Dependency cycle: keep going rather than silently dropping a target.
      return;
    }
    state.set(target.id, "visiting");
    for (const dependency of project.dependencies(target.id)) {
      if (!byId.has(dependency.targetId)) continue;
      visit(byId.get(dependency.targetId), [...stack, target.id]);
    }
    state.set(target.id, "done");
    ordered.push(target);
  };

  for (const target of targets) visit(target, []);
  return ordered;
}

function sourceKind(path) {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".swift":
      return "swift";
    case ".m":
      return "objc";
    case ".mm":
      return "objc++";
    case ".c":
      return "c";
    case ".cc":
    case ".cpp":
    case ".cxx":
      return "c++";
    case ".metal":
      return "metal";
    default:
      return null;
  }
}

function clangLanguage(kind) {
  switch (kind) {
    case "objc":
      return "objective-c";
    case "objc++":
      return "objective-c++";
    case "c":
      return "c";
    case "c++":
      return "c++";
    default:
      return null;
  }
}

function optimizationFlag(settings) {
  const level = getSetting(settings, "GCC_OPTIMIZATION_LEVEL", "");
  if (!level) return [];
  return [`-O${level}`];
}

function debugFlags(settings, target) {
  const format = getSetting(settings, "DEBUG_INFORMATION_FORMAT", "dwarf");
  if (!format || format === "none") return [];
  const flags = ["-g"];
  if (format === "dwarf-with-dsym") {
    void target;
    flags.push("-gline-tables-only");
  }
  return flags;
}

export function swiftLanguageMode(value) {
  const requested = String(value).trim();
  const mode = requested.endsWith(".0") ? requested.slice(0, -2) : requested;
  if (!["4", "4.2", "5", "6"].includes(mode)) {
    throw new Error(`Unsupported SWIFT_VERSION ${JSON.stringify(requested)}; supported language modes: 4, 4.2, 5, 6`);
  }
  return mode;
}

function swiftArgs({ settings, target, sources, triple, sdkPath, executablePath, isBundle, frameworks }) {
  const args = sources.map((source) => expandPath(source.path, settings));
  const moduleName = getSetting(settings, "SWIFT_MODULE_NAME", settings.PRODUCT_MODULE_NAME || target.name);
  args.push("-module-name", moduleName);
  args.push("-target", triple);
  if (sdkPath) args.push("-sdk", sdkPath);
  if (settings.SWIFT_VERSION) args.push("-swift-version", swiftLanguageMode(settings.SWIFT_VERSION));
  if (settings.SWIFT_OPTIMIZATION_LEVEL) args.push(settings.SWIFT_OPTIMIZATION_LEVEL);
  args.push(...debugFlags(settings, target));
  if (getSetting(settings, "ENABLE_TESTABILITY", "NO") === "YES") args.push("-enable-testing");

  for (const condition of splitSettingList(settings, "SWIFT_ACTIVE_COMPILATION_CONDITIONS")) {
    if (condition === "$(inherited)") continue;
    args.push("-D", condition);
  }
  for (const define of splitSettingList(settings, "GCC_PREPROCESSOR_DEFINITIONS")) {
    if (define === "$(inherited)") continue;
    args.push("-Xcc", `-D${define}`);
  }
  for (const path of splitSettingList(settings, "HEADER_SEARCH_PATHS")) args.push("-Xcc", `-I${path}`);
  for (const path of splitSettingList(settings, "SWIFT_INCLUDE_PATHS")) args.push("-I", path);
  for (const path of splitSettingList(settings, "FRAMEWORK_SEARCH_PATHS")) args.push("-F", path);
  if (settings.SWIFT_OBJC_BRIDGING_HEADER) {
    args.push("-import-objc-header", resolveProjectFile(settings.SWIFT_OBJC_BRIDGING_HEADER, settings));
  }
  for (const flag of splitSettingList(settings, "OTHER_SWIFT_FLAGS")) args.push(flag);
  if (isBundle) args.push("-emit-library");
  args.push("-o", executablePath);

  for (const path of splitSettingList(settings, "LD_RUNPATH_SEARCH_PATHS")) {
    args.push("-Xlinker", "-rpath", "-Xlinker", path);
  }
  for (const flag of splitSettingList(settings, "OTHER_LDFLAGS")) {
    if (flag === "$(inherited)") continue;
    args.push(flag);
  }
  for (const path of splitSettingList(settings, "LIBRARY_SEARCH_PATHS")) args.push("-L", path);
  for (const library of splitSettingList(settings, "OTHER_LIBRARIES")) {
    if (library === "$(inherited)") continue;
    args.push("-l", library);
  }
  args.push(...frameworkLinkArgs(frameworks, settings));
  return args;
}

function clangCompileArgs({ settings, source, objectPath, triple, sdkPath, language }) {
  const args = ["-c", expandPath(source, settings), "-o", objectPath];
  args.push("-target", triple);
  if (sdkPath) args.push("-isysroot", sdkPath);
  if (language) args.push("-x", language);
  if (getSetting(settings, "CLANG_ENABLE_OBJC_ARC", "NO") === "YES" && language?.startsWith("objective-c")) {
    args.push("-fobjc-arc");
  }
  if (getSetting(settings, "CLANG_ENABLE_OBJC_WEAK", "NO") === "YES") args.push("-fobjc-weak");
  if (getSetting(settings, "CLANG_ENABLE_MODULES", "NO") === "YES") args.push("-fmodules");
  args.push(...optimizationFlag(settings));
  args.push(...debugFlags(settings));
  const standard =
    language === "c++" || language === "objective-c++"
      ? getSetting(settings, "CLANG_CXX_LANGUAGE_STANDARD", "")
      : getSetting(settings, "GCC_C_LANGUAGE_STANDARD", "");
  if (standard) args.push(`-std=${standard}`);
  for (const define of splitSettingList(settings, "GCC_PREPROCESSOR_DEFINITIONS")) {
    if (define === "$(inherited)") continue;
    args.push(`-D${define}`);
  }
  for (const path of splitSettingList(settings, "HEADER_SEARCH_PATHS")) args.push("-I", path);
  for (const path of splitSettingList(settings, "FRAMEWORK_SEARCH_PATHS")) args.push("-F", path);
  for (const flag of splitSettingList(settings, "OTHER_CFLAGS")) args.push(flag);
  for (const flag of source.compilerFlags ?? []) args.push(flag);
  return args;
}

function clangLinkArgs({ settings, target, objects, executablePath, triple, sdkPath, isBundle, frameworks }) {
  const args = [...objects];
  args.push("-o", executablePath);
  args.push("-target", triple);
  if (sdkPath) args.push("-isysroot", sdkPath);
  if (isBundle) args.push("-bundle");
  else if (getSetting(settings, "MACH_O_TYPE", "") === "mh_dylib") args.push("-dynamiclib");
  for (const path of splitSettingList(settings, "LD_RUNPATH_SEARCH_PATHS")) {
    args.push("-Xlinker", "-rpath", "-Xlinker", path);
  }
  for (const path of splitSettingList(settings, "LIBRARY_SEARCH_PATHS")) args.push("-L", path);
  for (const library of splitSettingList(settings, "OTHER_LIBRARIES")) {
    if (library === "$(inherited)") continue;
    args.push("-l", library);
  }
  for (const flag of splitSettingList(settings, "OTHER_LDFLAGS")) {
    if (flag === "$(inherited)") continue;
    args.push(flag);
  }
  args.push(...frameworkLinkArgs(frameworks, settings));
  void target;
  return args;
}

function frameworkLinkArgs(frameworks, settings) {
  const args = [];
  const seen = new Set();
  for (const framework of frameworks) {
    const path = expandPath(framework.path, settings);
    if (!path) continue;
    if (path.endsWith(".framework") || path.includes(".framework/")) {
      const name = framework.framework ?? fileStem(path.slice(0, path.indexOf(".framework") + ".framework".length));
      const directory = path.slice(0, path.indexOf(".framework") + ".framework".length);
      args.push("-F", dirname(directory));
      if (!seen.has(`framework:${name}`)) {
        seen.add(`framework:${name}`);
        args.push("-framework", name);
      }
    } else if (path.endsWith(".xcframework")) {
      const name = framework.framework ?? fileStem(path);
      args.push("-F", dirname(path));
      if (!seen.has(`framework:${name}`)) {
        seen.add(`framework:${name}`);
        args.push("-framework", name);
      }
    } else {
      args.push(path);
    }
  }
  return args;
}

function resourceKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".xcassets") return "assetcatalog";
  if (extension === ".storyboard") return "storyboard";
  if (extension === ".xib") return "xib";
  if (extension === ".strings" || extension === ".stringsdict") return "strings";
  if (extension === ".plist") return "plist";
  if (extension === ".atlas") return "atlas";
  return "copy";
}

function copyDestinationDirectory(entry, { productPath, resourcesDir, frameworksDir, pluginsDir, builtProductsDir }) {
  switch (entry.destination) {
    case "Frameworks":
      return frameworksDir;
    case "PlugIns":
      return pluginsDir;
    case "Resources":
      return resourcesDir;
    case "Products":
      return builtProductsDir;
    case "Executables":
      return join(productPath, "Contents", "MacOS");
    case "Wrapper":
      return productPath;
    default:
      return entry.destination
        ? join(productPath, entry.destination)
        : resourcesDir;
  }
}

/**
 * Plan one target: directories, compilation, linking, resources, bundle
 * assembly, embedding and signing. The result is inert data; nothing runs.
 */
export function planTarget({
  project,
  target,
  configuration,
  settings,
  platform,
  arch,
  sdkPath = null,
  deploymentTarget = null,
  productType = null,
  buildTargets = new Set(),
}) {
  const productInfo = productTypeInfo(productType ?? target.productType);
  const warnings = [];
  const steps = [];

  if (target.packageProductDependencies?.length > 0) {
    const names = [
      ...new Set(
        target.packageProductDependencies.map((id) => project.objects?.[id]?.productName ?? id),
      ),
    ];
    warnings.push(
      `Swift Package products are not built by xcl (${names.join(", ")}); build them with swift build or Xcode`,
    );
  }

  const builtProductsDir = settings.BUILT_PRODUCTS_DIR;
  // Hosted XCTest bundles must actually be placed inside the host app's
  // PlugIns directory. Keep BUILT_PRODUCTS_DIR as the shared dependency root.
  const hostedTest = productInfo.kind === "unit-test" &&
    Boolean(settings.TARGET_BUILD_SUBPATH) && Boolean(settings.TARGET_BUILD_DIR);
  const productOutputDir = hostedTest ? settings.TARGET_BUILD_DIR : builtProductsDir;
  const targetTempDir = settings.TARGET_TEMP_DIR;
  const objectDir = join(targetTempDir, "Objects-normal", arch);
  const effectiveDeploymentTarget =
    deploymentTarget ||
    settings.DEPLOYMENT_TARGET ||
    settings.IPHONEOS_DEPLOYMENT_TARGET ||
    settings.MINIMUM_DEPLOYMENT_TARGET ||
    "1.0";
  const triple = targetTriple(platform, arch, effectiveDeploymentTarget);

  let productPath = project.productPath(target.id);
  productPath = productPath ? expandPath(productPath, settings) : "";
  if (!productPath || hostedTest) productPath = join(productOutputDir, settings.WRAPPER_NAME);

  const isWrapper = Boolean(productInfo.wrapperExtension);
  const resourcesDir = isWrapper
    ? join(productOutputDir, expandPath(settings.UNLOCALIZED_RESOURCES_FOLDER_PATH || settings.WRAPPER_NAME, settings))
    : "";
  const frameworksDir = isWrapper
    ? join(productOutputDir, expandPath(settings.FRAMEWORKS_FOLDER_PATH || settings.WRAPPER_NAME, settings))
    : "";
  const pluginsDir = isWrapper
    ? join(productOutputDir, expandPath(settings.PLUGINS_FOLDER_PATH || settings.WRAPPER_NAME, settings))
    : "";
  const infoPlistPath = isWrapper
    ? join(productOutputDir, expandPath(settings.INFOPLIST_PATH || `${settings.WRAPPER_NAME}/Info.plist`, settings))
    : "";
  const executablePath = isWrapper
    ? join(productOutputDir, expandPath(settings.EXECUTABLE_PATH || settings.WRAPPER_NAME, settings))
    : join(productOutputDir, expandPath(settings.EXECUTABLE_NAME || settings.PRODUCT_NAME, settings));

  // --- directories -------------------------------------------------------
  const directories = [
    objectDir,
    builtProductsDir,
    targetTempDir,
    ...(isWrapper ? [productPath, resourcesDir, frameworksDir, pluginsDir] : []),
    ...(isWrapper ? [dirname(executablePath), dirname(infoPlistPath)] : []),
  ];
  const uniqueDirectories = [...new Set(directories.filter(Boolean))];
  if (uniqueDirectories.length > 0) {
    steps.push(
      makeStep({
        kind: "mkdir",
        title: `Create build directories for ${target.name}`,
        tool: "mkdir",
        args: ["-p", ...uniqueDirectories],
        outputs: uniqueDirectories,
      }),
    );
  }

  // --- sources -----------------------------------------------------------
  const sources = project.sources(target.id);
  const swiftSources = sources.filter((source) => sourceKind(source.path) === "swift");
  const clangSources = sources.filter((source) => {
    const kind = sourceKind(source.path);
    return kind && kind !== "swift" && kind !== "metal";
  });
  const metalSources = sources.filter((source) => sourceKind(source.path) === "metal");
  const frameworks = project.frameworks(target.id);
  const isBundle = productInfo.machOType === "mh_bundle";
  const isStaticArchive = productInfo.machOType === "staticlib";

  if (sources.length === 0) {
    warnings.push(`target ${target.name} has no compilable sources`);
  }

  const objectFiles = [];
  for (const source of clangSources) {
    const kind = sourceKind(source.path);
    const stem = fileStem(source.path);
    const objectPath = join(objectDir, `${stem}.o`);
    objectFiles.push(objectPath);
    steps.push(
      makeStep({
        kind: "compile",
        title: `Compile ${basename(source.path)}`,
        tool: "xcrun",
        args: [
          "clang",
          ...clangCompileArgs({
            settings,
            source: source.path,
            objectPath,
            triple,
            sdkPath,
            language: clangLanguage(kind),
          }),
        ],
        inputs: [expandPath(source.path, settings)],
        outputs: [objectPath],
        description: `${kind} source`,
      }),
    );
  }

  for (const source of metalSources) {
    const stem = fileStem(source.path);
    const airPath = join(objectDir, `${stem}.air`);
    const metalPath = join(objectDir, `${stem}.metallib`);
    steps.push(
      makeStep({
        kind: "compile",
        title: `Compile ${basename(source.path)}`,
        tool: "xcrun",
        args: [
          "metal",
          "-c",
          expandPath(source.path, settings),
          "-o",
          airPath,
          "-target",
          triple,
          ...(sdkPath ? ["-isysroot", sdkPath] : []),
        ],
        inputs: [expandPath(source.path, settings)],
        outputs: [airPath],
        description: "Metal shader",
      }),
    );
    steps.push(
      makeStep({
        kind: "link",
        title: `Link ${stem}.metallib`,
        tool: "xcrun",
        args: ["metallib", airPath, "-o", metalPath],
        inputs: [airPath],
        outputs: [metalPath],
      }),
    );
  }

  if (swiftSources.length > 0) {
    steps.push(
      makeStep({
        kind: "link",
        title: `Compile and link ${target.name}`,
        tool: "xcrun",
        args: [
          "swiftc",
          ...swiftArgs({
            settings,
            target,
            sources: swiftSources,
            triple,
            sdkPath,
            executablePath,
            isBundle: isBundle || isStaticArchive,
            frameworks,
          }),
        ],
        inputs: swiftSources.map((source) => expandPath(source.path, settings)),
        outputs: [executablePath],
        description: "swiftc driver (whole-module)",
      }),
    );
  } else if (objectFiles.length > 0) {
    if (isStaticArchive) {
      steps.push(
        makeStep({
          kind: "link",
          title: `Archive ${target.name}`,
          tool: "xcrun",
          args: ["libtool", "-static", "-o", executablePath, ...objectFiles],
          inputs: objectFiles,
          outputs: [executablePath],
          description: "static library",
        }),
      );
    } else {
      steps.push(
        makeStep({
          kind: "link",
          title: `Link ${target.name}`,
          tool: "xcrun",
          args: [
            "clang",
            ...clangLinkArgs({
              settings,
              target,
              objects: objectFiles,
              executablePath,
              triple,
              sdkPath,
              isBundle,
              frameworks,
            }),
          ],
          inputs: objectFiles,
          outputs: [executablePath],
        }),
      );
    }
  }

  // --- resources ---------------------------------------------------------
  const infoPlistFile = resolveProjectFile(settings.INFOPLIST_FILE ?? "", settings);
  let assetInfoPartial = "";
  if (isWrapper && productInfo.infoplistPath) {
    const assetCatalogSources = [];
    const resourceEntries = project.resources(target.id);
    resourceEntries.forEach((entry) => {
      const source = expandPath(entry.path, settings);
      if (!source) return;
      if (infoPlistFile && source === infoPlistFile) return;
      const kind = resourceKind(source);
      const name = basename(source);

      if (kind === "assetcatalog") {
        assetCatalogSources.push(source);
        return;
      }

      if (kind === "storyboard" || kind === "xib") {
        const compiled = join(resourcesDir, `${fileStem(source)}.${kind === "storyboard" ? "storyboardc" : "nib"}`);
        steps.push(
          makeStep({
            kind: "resource",
            title: `Compile ${name}`,
            tool: "xcrun",
            args: [
              "ibtool",
              "--compile",
              compiled,
              source,
              "--minimum-deployment-target",
              String(effectiveDeploymentTarget),
            ],
            inputs: [source],
            outputs: [compiled],
            description: "ibtool",
          }),
        );
        return;
      }

      if (kind === "strings" || kind === "plist") {
        const destination = join(resourcesDir, name);
        steps.push(
          makeStep({
            kind: "resource",
            title: `Process ${name}`,
            tool: "plutil",
            args: ["-convert", "binary1", source, "-o", destination],
            inputs: [source],
            outputs: [destination],
            description: "binary property list",
          }),
        );
        return;
      }

      const destination = join(resourcesDir, name);
      steps.push(
        makeStep({
          kind: "resource",
          title: `Copy ${name}`,
          tool: "cp",
          args: ["-R", source, destination],
          inputs: [source],
          outputs: [destination],
        }),
      );
    });

    // actool must receive all catalogs together: global app-icon/accent names
    // can be declared in one catalog while other catalogs contain previews.
    // Separate invocations may fail and can overwrite a shared Assets.car.
    const catalogs = [...new Set(assetCatalogSources)];
    if (catalogs.length > 0) {
      const partial = join(targetTempDir, "AssetCatalogs_generated_info.plist");
      assetInfoPartial = partial;
      const args = [
        "actool",
        ...catalogs,
        "--compile",
        resourcesDir,
        "--platform",
        platform,
        "--minimum-deployment-target",
        String(effectiveDeploymentTarget),
        "--output-partial-info-plist",
        partial,
        "--errors",
        "--warnings",
        "--notices",
      ];
      if (settings.ASSETCATALOG_COMPILER_APPICON_NAME) {
        args.push("--app-icon", settings.ASSETCATALOG_COMPILER_APPICON_NAME);
      }
      if (settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME) {
        args.push("--accent-color", settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME);
      }
      steps.push(
        makeStep({
          kind: "resource",
          title: "Compile asset catalogs",
          tool: "xcrun",
          args,
          inputs: catalogs,
          outputs: [resourcesDir, partial],
          description: "actool (all catalogs in one invocation)",
        }),
      );
    }
  }

  // --- PkgInfo -----------------------------------------------------------
  if (platform === "macosx" && ["application", "watch-application"].includes(productInfo.kind)) {
    const pkginfoPath = join(productPath, "Contents", "PkgInfo");
    steps.push(
      makeStep({
        kind: "bundle",
        title: "Write PkgInfo",
        tool: "xcl-internal",
        args: ["write-pkginfo", pkginfoPath],
        outputs: [pkginfoPath],
        description: "APPL????",
      }),
    );
  }

  // --- Info.plist --------------------------------------------------------
  if (isWrapper && productInfo.infoplistPath) {
    if (infoPlistFile) {
      steps.push(
        makeStep({
          kind: "bundle",
          title: "Process Info.plist",
          tool: "xcl-internal",
          args: ["process-info-plist", infoPlistFile, infoPlistPath],
          inputs: [infoPlistFile],
          outputs: [infoPlistPath],
          description: "variables expanded with the resolved build settings",
        }),
      );
    } else {
      steps.push(
        makeStep({
          kind: "bundle",
          title: "Generate Info.plist",
          tool: "xcl-internal",
          args: ["generate-info-plist", infoPlistPath],
          outputs: [infoPlistPath],
          description:
            settings.GENERATE_INFOPLIST_FILE === "YES"
              ? "from INFOPLIST_KEY_* settings"
              : "no INFOPLIST_FILE configured; generated with template defaults",
        }),
      );
    }
  }

  // Merge actool's icon metadata into the final Info.plist before signing.
  // actool's com.apple.actool.* diagnostics are deliberately excluded.
  if (assetInfoPartial) {
    steps.push(
      makeStep({
        kind: "bundle",
        title: "Merge asset catalog Info.plist",
        tool: "xcl-internal",
        args: ["merge-asset-info-plist", assetInfoPartial, infoPlistPath],
        inputs: [assetInfoPartial, infoPlistPath],
        outputs: [infoPlistPath],
        description: "asset-generated icon metadata",
      }),
    );
  }

  // --- copy files --------------------------------------------------------
  for (const entry of project.copyFiles(target.id)) {
    const source = expandPath(entry.path, settings);
    if (!source) continue;
    const destinationDirectory = copyDestinationDirectory(entry, {
      productPath,
      resourcesDir,
      frameworksDir,
      pluginsDir,
      builtProductsDir,
    });
    const destination = join(destinationDirectory, basename(source));
    steps.push(
      makeStep({
        kind: "copy",
        title: `Embed ${basename(source)}`,
        tool: "cp",
        args: ["-R", source, destination],
        inputs: [source],
        outputs: [destination],
        description: `Copy Files -> ${entry.destination}`,
      }),
    );
  }

  // --- embed dependencies -------------------------------------------------
  for (const dependency of project.dependencies(target.id)) {
    if (buildTargets.size > 0 && !buildTargets.has(dependency.targetId)) continue;
    const dependencyTarget = project.target(dependency.targetId);
    if (!dependencyTarget) continue;
    const dependencyInfo = productTypeInfo(dependencyTarget.productType);
    if (!["framework", "static-framework", "dynamic-library", "app-extension", "xpc-service"].includes(
      dependencyInfo.kind,
    )) {
      continue;
    }
    const dependencyProduct =
      expandPath(project.productPath(dependencyTarget.id) ?? "", settings) ||
      join(builtProductsDir, `${dependencyTarget.name}.${dependencyInfo.wrapperExtension}`);
    const destinationDirectory =
      dependencyInfo.kind === "app-extension" || dependencyInfo.kind === "xpc-service"
        ? pluginsDir
        : frameworksDir;
    const destination = join(destinationDirectory, basename(dependencyProduct));
    steps.push(
      makeStep({
        kind: "copy",
        title: `Embed ${basename(dependencyProduct)}`,
        tool: "cp",
        args: ["-R", dependencyProduct, destination],
        inputs: [dependencyProduct],
        outputs: [destination],
        description: `dependency -> ${dependencyInfo.kind}`,
      }),
    );
  }

  // --- signing -----------------------------------------------------------
  const signingAllowed = getSetting(settings, "CODE_SIGNING_ALLOWED", "YES") !== "NO";
  if (signingAllowed && productInfo.wrapperExtension) {
    const identity = settings.EXPANDED_CODE_SIGN_IDENTITY || settings.CODE_SIGN_IDENTITY || "-";
    const args = ["codesign", "--force", "--sign", identity, "--timestamp=none"];
    const entitlements = resolveProjectFile(settings.CODE_SIGN_ENTITLEMENTS ?? "", settings);
    if (entitlements) args.push("--entitlements", entitlements);
    args.push(productPath);
    steps.push(
      makeStep({
        kind: "sign",
        title: `Code sign ${settings.WRAPPER_NAME}`,
        tool: "xcrun",
        args,
        inputs: [productPath],
        outputs: [productPath],
        description: identity === "-" ? "ad-hoc signature" : identity,
      }),
    );
  }

  // --- shell scripts -----------------------------------------------------
  for (const script of project.shellScripts(target.id)) {
    steps.push(
      makeStep({
        kind: "script",
        title: script.name,
        tool: script.shellPath || "/bin/sh",
        args: ["-c", script.script],
        inputs: script.inputPaths.map((path) => expandPath(path, settings)),
        outputs: script.outputPaths.map((path) => expandPath(path, settings)),
        description: script.alwaysOutOfDate ? "always runs" : "shell script phase",
      }),
    );
  }

  if (!sdkPath) {
    warnings.push(`no SDK found for ${platform}; commands use symbolic paths only`);
  }

  return {
    target: {
      id: target.id,
      name: target.name,
      productType: target.productType,
      productKind: productInfo.kind,
      productPath,
      executablePath,
      wrapperName: settings.WRAPPER_NAME,
    },
    configuration,
    platform,
    arch,
    triple,
    settings,
    steps: uniqueSteps(steps),
    warnings,
  };
}

function uniqueSteps(steps) {
  const seen = new Set();
  const result = [];
  for (const step of steps) {
    const key = `${step.kind}|${step.display}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(step);
  }
  return result;
}

/**
 * Plan a whole project: order targets by dependency, resolve settings for each
 * and return plans plus project-level warnings.
 */
export function planBuild({
  project,
  targets,
  configuration,
  resolveSettings,
  platform,
  arch,
  sdkPath = null,
  deploymentTarget = null,
}) {
  const ordered = orderTargets(project, targets);
  const builtTargets = new Set(ordered.map((target) => target.id));
  const plans = [];
  const warnings = [];

  for (const target of ordered) {
    const { settings, warnings: settingWarnings } = resolveSettings(target);
    for (const warning of settingWarnings ?? []) warnings.push(`${target.name}: ${warning}`);
    const plan = planTarget({
      project,
      target,
      configuration,
      settings,
      platform,
      arch,
      sdkPath,
      deploymentTarget: deploymentTarget ?? settings.DEPLOYMENT_TARGET,
      buildTargets: builtTargets,
    });
    warnings.push(...plan.warnings.map((warning) => `${target.name}: ${warning}`));
    plans.push(plan);
  }

  return { targets: plans, warnings };
}

export { expandPlistValue };
