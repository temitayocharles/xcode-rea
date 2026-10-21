import { homedir } from "node:os";
import { readPlistFile } from "../plist/index.js";
import { basename, dirname, join } from "node:path";
import { sha256 } from "../util/text.js";
import { productTypeInfo } from "./productTypes.js";
import { hostAccountSettings, hostXcodeCacheSettings, hostMacOSVersionSettings } from "./host.js";

/**
 * Xcode's DerivedData directory name includes a stable 28-character hash that
 * Xcode derives internally. The exact algorithm is not public; xcl uses its own
 * deterministic SHA-256-derived suffix. This only affects the default location,
 * never the contents of a build. Use `-derivedDataPath` for exact parity.
 */
export function defaultDerivedDataPath(projectPath) {
  const name = basename(projectPath).replace(/\.xcodeproj$/, "");
  const hash = BigInt(`0x${sha256(projectPath).slice(0, 16)}`)
    .toString(36)
    .padStart(28, "0")
    .slice(0, 28);
  return join(homedir(), "Library", "Developer", "Xcode", "DerivedData", `${name}-${hash}`);
}

export function effectivePlatformName(platform) {
  switch (platform) {
    case "iphonesimulator":
      return "-iphonesimulator";
    case "appletvsimulator":
      return "-appletvsimulator";
    case "watchsimulator":
      return "-watchsimulator";
    case "xrsimulator":
      return "-xrsimulator";
    default:
      return "";
  }
}

const DEPLOYMENT_TARGET_SETTING = {
  iphoneos: "IPHONEOS_DEPLOYMENT_TARGET",
  iphonesimulator: "IPHONEOS_DEPLOYMENT_TARGET",
  macosx: "MACOSX_DEPLOYMENT_TARGET",
  appletvos: "TVOS_DEPLOYMENT_TARGET",
  appletvsimulator: "TVOS_DEPLOYMENT_TARGET",
  watchos: "WATCHOS_DEPLOYMENT_TARGET",
  watchsimulator: "WATCHOS_DEPLOYMENT_TARGET",
  xros: "XROS_DEPLOYMENT_TARGET",
  xrsimulator: "XROS_DEPLOYMENT_TARGET",
};

const MINIMUM_DEPLOYMENT_TARGET = {
  iphoneos: "13.0",
  iphonesimulator: "13.0",
  macosx: "10.15",
  appletvos: "13.0",
  appletvsimulator: "13.0",
  watchos: "6.0",
  watchsimulator: "6.0",
  xros: "1.0",
  xrsimulator: "1.0",
};

const PLATFORM_LABELS = {
  iphoneos: ["iOS", "iOS", "arm64"],
  iphonesimulator: ["iOS Simulator", "iOS", "x86_64"],
  macosx: ["macOS", "macOS", null],
  appletvos: ["tvOS", "tvOS", "arm64"],
  appletvsimulator: ["tvOS Simulator", "tvOS", null],
  watchos: ["watchOS", "watchOS", "arm64_32"],
  watchsimulator: ["watchOS Simulator", "watchOS", null],
  xros: ["visionOS", "visionOS", "arm64"],
  xrsimulator: ["visionOS Simulator", "visionOS", null],
};

export function sdkVersionSettings(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version ?? ""));
  if (!match) return {};
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (major > 999 || minor > 99 || patch > 99) return {};
  return {
    SDK_VERSION_ACTUAL: String(major * 10000 + minor * 100 + patch),
    SDK_VERSION_MAJOR: String(major * 10000),
    SDK_VERSION_MINOR: String(major * 10000 + minor * 100 + patch),
  };
}

const PLATFORM_DIR_NAME = {
  iphoneos: "iPhoneOS",
  iphonesimulator: "iPhoneSimulator",
  macosx: "MacOSX",
  appletvos: "AppleTVOS",
  appletvsimulator: "AppleTVSimulator",
  watchos: "WatchOS",
  watchsimulator: "WatchSimulator",
  xros: "XROS",
  xrsimulator: "XRSimulator",
};

const SDKROOT_NAME = {
  iphoneos: "iphoneos",
  iphonesimulator: "iphonesimulator",
  macosx: "macosx",
  appletvos: "appletvos",
  appletvsimulator: "appletvsimulator",
  watchos: "watchos",
  watchsimulator: "watchsimulator",
  xros: "xros",
  xrsimulator: "xrsimulator",
};

const SUPPORTED_PLATFORMS = {
  iphoneos: "iphoneos iphonesimulator",
  iphonesimulator: "iphoneos iphonesimulator",
  macosx: "macosx",
  appletvos: "appletvos appletvsimulator",
  appletvsimulator: "appletvos appletvsimulator",
  watchos: "watchos watchsimulator",
  watchsimulator: "watchos watchsimulator",
  xros: "xros xrsimulator",
  xrsimulator: "xros xrsimulator",
};

function standardArchitectures(platform, hostArch) {
  switch (platform) {
    case "iphoneos":
      return "arm64";
    case "iphonesimulator":
      // Xcode's requested simulator architecture set is independent of which
      // architecture ONLY_ACTIVE_ARCH selects for a particular build.
      return "arm64 x86_64";
    case "macosx":
      return "arm64 x86_64";
    case "appletvos":
      return "arm64";
    case "appletvsimulator":
      return "arm64 x86_64";
    case "watchos":
      return "arm64_32 arm64";
    case "watchsimulator":
      return hostArch === "arm64" ? "arm64" : "x86_64";
    default:
      return hostArch;
  }
}

function bundleLayoutDefaults(platform, productInfo) {
  if (!productInfo.wrapperExtension) return {};
  const ancillary = {
    PUBLIC_HEADERS_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Headers",
    PRIVATE_HEADERS_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/PrivateHeaders",
    SHALLOW_BUNDLE: platform === "macosx" ? "NO" : "YES",
  };
  const bundleLike = [
    "application",
    "watch-application",
    "app-extension",
    "bundle",
    "xpc-service",
    "unit-test",
    "ui-test",
  ].includes(productInfo.kind);

  // macOS application-style bundles use a Contents/ layout. Frameworks and
  // dylibs stay flat in xcl (documented divergence: no Versions/A symlinks).
  if (platform === "macosx" && bundleLike) {
    const layout = {
      CONTENTS_FOLDER_PATH: "$(WRAPPER_NAME)/Contents",
      UNLOCALIZED_RESOURCES_FOLDER_PATH: "$(WRAPPER_NAME)/Contents/Resources",
      FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/Contents/Frameworks",
      PLUGINS_FOLDER_PATH: "$(WRAPPER_NAME)/Contents/PlugIns",
      SHARED_FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/Contents/SharedFrameworks",
      EXECUTABLE_PATH: "$(WRAPPER_NAME)/Contents/MacOS/$(EXECUTABLE_NAME)",
      INFOPLIST_PATH: "$(WRAPPER_NAME)/Contents/Info.plist",
    };
    return { ...layout, ...ancillary };
  }

  const layout = {
    CONTENTS_FOLDER_PATH: "$(WRAPPER_NAME)",
    UNLOCALIZED_RESOURCES_FOLDER_PATH: "$(WRAPPER_NAME)",
    FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/Frameworks",
    PLUGINS_FOLDER_PATH: "$(WRAPPER_NAME)/PlugIns",
    SHARED_FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/SharedFrameworks",
  };
  return { ...layout, ...ancillary };
}

/**
 * Platform bundles publish machine-installed DefaultProperties in Info.plist.
 * Respect their conditional setting keys; the regular resolver applies them
 * with the same conditional-precedence rules as project xcconfigs.
 *
 * Version metadata is only emitted when Xcode itself actually supplies a
 * ProductBuildVersion; CFBundleVersion is a different concept.
 */
export function installedPlatformProperties(developerDir, platform) {
  const name = PLATFORM_DIR_NAME[platform];
  if (!developerDir || !name) return {};
  const root = join(developerDir, "Platforms", `${name}.platform`);
  let info = {};
  try { info = readPlistFile(join(root, "Info.plist")); } catch { /* absent on CLT */ }
  let version = {};
  try { version = readPlistFile(join(root, "version.plist")); } catch { /* optional */ }
  const properties = info.DefaultProperties;
  const defaults = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.fromEntries(Object.entries(properties).filter(([key, value]) =>
        typeof key === "string" && ["string", "number", "boolean"].includes(typeof value)))
    : {};
  const buildVersion = version.ProductBuildVersion ?? info.ProductBuildVersion;
  if (typeof buildVersion === "string" && buildVersion) {
    defaults.PLATFORM_PRODUCT_BUILD_VERSION = buildVersion;
  }
  return defaults;
}

export function platformDefaults(context) {
  const { platform, sdk, hostArch, sdkDir, developerDir } = context;
  const sdkRoot = SDKROOT_NAME[platform] ?? platform;
  const deploymentSetting = DEPLOYMENT_TARGET_SETTING[platform] ?? "DEPLOYMENT_TARGET";
  const sdkDefaults = sdk?.defaultProperties ?? {};
  const deploymentTarget =
    sdkDefaults[deploymentSetting] ?? MINIMUM_DEPLOYMENT_TARGET[platform] ?? "1.0";
  const platformDir = developerDir ? join(developerDir, "Platforms", `${PLATFORM_DIR_NAME[platform] ?? platform}.platform`) : "";
  const platformDeveloperDir = platformDir ? join(platformDir, "Developer") : "";
  const localizedResources = "$(CONTENTS_FOLDER_PATH)/$(DEVELOPMENT_LANGUAGE).lproj";
  const standardArch = standardArchitectures(platform, hostArch);
  const [displayName, familyName, preferredArch] = PLATFORM_LABELS[platform] ?? [platform, platform, null];

  const defaults = {
    SDKROOT: sdk?.path ?? sdkRoot,
    PLATFORM_NAME: platform,
    PLATFORM_DISPLAY_NAME: displayName,
    PLATFORM_FAMILY_NAME: familyName,
    PLATFORM_PREFERRED_ARCH: preferredArch ?? hostArch,
    EFFECTIVE_PLATFORM_NAME: effectivePlatformName(platform),
    SUPPORTED_PLATFORMS: SUPPORTED_PLATFORMS[platform] ?? platform,
    [deploymentSetting]: deploymentTarget,
    DEPLOYMENT_TARGET: `$(${deploymentSetting})`,
    MINIMUM_DEPLOYMENT_TARGET: deploymentTarget,
    ARCHS_STANDARD: standardArch,
    ARCHS_STANDARD_64_BIT: standardArch,
    ARCHS_STANDARD_INCLUDING_64_BIT: standardArch,
    ARCHS_BASE: "$(ARCHS_STANDARD)",
    VALID_ARCHS: standardArch,
    DEPLOYMENT_TARGET_SETTING_NAME: deploymentSetting,
    NATIVE_ARCH: hostArch,
    NATIVE_ARCH_ACTUAL: hostArch,
    CODE_SIGNING_ALLOWED: "YES",
    CODE_SIGNING_REQUIRED: "YES",
    CODE_SIGN_IDENTITY: "-",
    EXPANDED_CODE_SIGN_IDENTITY: "-",
    ENABLE_BITCODE: "NO",
    ...sdkDefaults,
  };

  if (sdk) {
    defaults.SDK_NAME = sdk.name;
    defaults.SDK_VERSION = sdk.version;
    defaults.SDK_DIR = sdk.path;
    Object.assign(defaults, sdkVersionSettings(sdk.version));
    if (sdk.path) {
      defaults[`SDK_DIR_${platform}`] = sdk.path;
      if (sdk.version) defaults[`SDK_DIR_${platform}${String(sdk.version).replace(/\./g, "_")}`] = sdk.path;
    }
    const sdkBuild = sdk.productBuildVersion ?? sdk.settings?.ProductBuildVersion;
    if (typeof sdkBuild === "string" && sdkBuild) {
      defaults.SDK_PRODUCT_BUILD_VERSION = sdkBuild;
    }
  } else {
    defaults.SDK_NAME = sdkRoot;
  }
  if (platformDir) {
    defaults.PLATFORM_DIR = platformDir;
    defaults.PLATFORM_DEVELOPER_APPLICATIONS_DIR = join(platformDeveloperDir, "Applications");
    defaults.PLATFORM_DEVELOPER_BIN_DIR = join(platformDeveloperDir, "usr", "bin");
    defaults.PLATFORM_DEVELOPER_LIBRARY_DIR = join(platformDeveloperDir, "Library");
    defaults.PLATFORM_DEVELOPER_SDK_DIR = join(platformDeveloperDir, "SDKs");
    defaults.PLATFORM_DEVELOPER_TOOLS_DIR = join(platformDeveloperDir, "Tools");
    defaults.PLATFORM_DEVELOPER_USR_DIR = join(platformDeveloperDir, "usr");
  }
  if (developerDir) {
    defaults.DEVELOPER_APPLICATIONS_DIR = join(developerDir, "Applications");
    defaults.DEVELOPER_BIN_DIR = join(developerDir, "usr", "bin");
    defaults.DEVELOPER_FRAMEWORKS_DIR = join(developerDir, "Library", "Frameworks");
    defaults.DEVELOPER_LIBRARY_DIR = join(developerDir, "Library");
    defaults.DEVELOPER_SDK_DIR = join(developerDir, "Platforms", "MacOSX.platform", "Developer", "SDKs");
    defaults.DEVELOPER_TOOLS_DIR = join(developerDir, "Tools");
    defaults.DEVELOPER_USR_DIR = join(developerDir, "usr");
  }

  switch (platform) {
    case "iphoneos":
      defaults.TARGETED_DEVICE_FAMILY = "1,2";
      defaults.CODE_SIGN_IDENTITY = "iPhone Developer";
      defaults.EXPANDED_CODE_SIGN_IDENTITY = "-";
      break;
    case "iphonesimulator":
      defaults.TARGETED_DEVICE_FAMILY = "1,2";
      defaults.CODE_SIGN_IDENTITY = "-";
      break;
    case "macosx":
      defaults.CODE_SIGN_IDENTITY = "-";
      defaults.COMBINE_HIDPI_IMAGES = "YES";
      break;
    case "watchos":
    case "watchsimulator":
      defaults.TARGETED_DEVICE_FAMILY = "4";
      break;
    case "appletvos":
    case "appletvsimulator":
      defaults.TARGETED_DEVICE_FAMILY = "3";
      break;
    default:
      break;
  }

  return defaults;
}

function templateConfigurationDefaults(configuration) {
  const debug = /^debug$/i.test(configuration);
  return debug
    ? {
        ONLY_ACTIVE_ARCH: "YES",
        ENABLE_TESTABILITY: "YES",
        DEAD_CODE_STRIPPING: "YES",
        DEBUG_INFORMATION_FORMAT: "dwarf",
        GCC_OPTIMIZATION_LEVEL: "0",
        GCC_PREPROCESSOR_DEFINITIONS: "$(inherited)",
        SWIFT_OPTIMIZATION_LEVEL: "-Onone",
        SWIFT_COMPILATION_MODE: "incremental",
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited)",
        MTL_ENABLE_DEBUG_INFO: "INCLUDE_SOURCE",
        ENABLE_NS_ASSERTIONS: "YES",
        VALIDATE_PRODUCT: "NO",
      }
    : {
        ONLY_ACTIVE_ARCH: "NO",
        ENABLE_TESTABILITY: "NO",
        DEAD_CODE_STRIPPING: "YES",
        DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
        GCC_OPTIMIZATION_LEVEL: "s",
        GCC_PREPROCESSOR_DEFINITIONS: "$(inherited)",
        SWIFT_OPTIMIZATION_LEVEL: "-O",
        SWIFT_COMPILATION_MODE: "wholemodule",
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited)",
        MTL_ENABLE_DEBUG_INFO: "NO",
        ENABLE_NS_ASSERTIONS: "NO",
        VALIDATE_PRODUCT: "YES",
      };
}

/**
 * Settings that come from Xcode's project templates and generic build-system
 * defaults. They are the lowest-priority layer; a project always wins.
 */
export function xcodeVersionSettings(version, build = null) {
  const text = String(version ?? "16.4");
  const parts = text.split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 16;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const actual = major * 100 + minor * 10;
  return {
    XCODE_VERSION: text,
    XCODE_VERSION_MAJOR: String(major * 100),
    XCODE_VERSION_MINOR: String(actual),
    XCODE_VERSION_ACTUAL: String(actual),
    XCODE_BUILD: build ?? "",
    XCODE_PRODUCT_BUILD_VERSION: build ?? "",
  };
}

export function genericDefaults(context) {
  const {
    project,
    projectPath,
    target,
    configuration,
    platform,
    sdk,
    arch,
    hostArch,
    derivedDataPath,
    developerDir,
    xcodeVersion,
    xcodeBuild,
  } = context;
  const projectDir = dirname(projectPath);
  const productsDir = join(
    derivedDataPath,
    "Build",
    "Products",
    `${configuration}${effectivePlatformName(platform)}`,
  );
  const objRoot = join(derivedDataPath, "Build", "Intermediates.noindex");
  const configurationTemp = join(
    objRoot,
    `${project.name}.build`,
    `${configuration}${effectivePlatformName(platform)}`,
  );
  const targetTemp = join(configurationTemp, `${target?.name ?? project.name}.build`);
  const derivedSources = join(targetTemp, "DerivedSources");
  const objectFilesRoot = join(targetTemp, "Objects");
  const productInfo = productTypeInfo(target?.productType ?? "");
  const productName = target?.productName ?? "$(TARGET_NAME)";
  // ARCHS is the requested architecture *set*, even when ONLY_ACTIVE_ARCH
  // selects one architecture for the actual build. The planner's separate
  // arch parameter determines the single-arch compile target.
  const archs = "$(ARCHS_STANDARD)";
  const configurationDefaults = templateConfigurationDefaults(configuration);

  return {
    ACTION: context.action ?? "build",
    CONFIGURATION: configuration,
    BUILD_COMPONENTS: context.action === "install" ? "install" : "headers build",
    CURRENT_VARIANT: "normal",
    DEFAULT_DEXT_INSTALL_PATH: "/System/Library/DriverExtensions",
    DEFAULT_KEXT_INSTALL_PATH: "/System/Library/Extensions",
    CONFIGURATION_BUILD_DIR: "$(BUILT_PRODUCTS_DIR)",
    BUILT_PRODUCTS_DIR: productsDir,
    TARGET_BUILD_DIR: "$(BUILT_PRODUCTS_DIR)",
    TARGET_BUILD_SUBPATH: "",
    CODESIGNING_FOLDER_PATH: "$(TARGET_BUILD_DIR)/$(FULL_PRODUCT_NAME)",
    METAL_LIBRARY_OUTPUT_DIR: "$(TARGET_BUILD_DIR)/$(FULL_PRODUCT_NAME)",
    BUILD_DIR: productsDir,
    SYMROOT: dirname(productsDir),
    OBJROOT: objRoot,
    CONFIGURATION_TEMP_DIR: configurationTemp,
    PROJECT_TEMP_DIR: join(objRoot, `${project.name}.build`),
    TARGET_TEMP_DIR: targetTemp,
    DERIVED_FILE_DIR: derivedSources,
    DERIVED_FILES_DIR: "$(DERIVED_FILE_DIR)",
    DERIVED_SOURCES_DIR: "$(DERIVED_FILE_DIR)",
    SHARED_DERIVED_FILE_DIR: "$(BUILT_PRODUCTS_DIR)/DerivedSources",
    GENERATED_MODULEMAP_DIR: join(objRoot, `GeneratedModuleMaps${effectivePlatformName(platform)}`),
    OBJECT_FILE_DIR: objectFilesRoot,
    OBJECT_FILE_DIR_normal: join(targetTemp, "Objects-normal"),
    FIXED_FILES_DIR: join(targetTemp, "FixedFiles"),
    REZ_COLLECTOR_DIR: join(targetTemp, "ResourceManagerResources"),
    DWARF_DSYM_FOLDER_PATH: "$(CONFIGURATION_BUILD_DIR)",
    DWARF_DSYM_FILE_NAME: "$(FULL_PRODUCT_NAME).dSYM",
    EXECUTABLE_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)",
    EXECUTABLES_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Executables",
    DOCUMENTATION_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/$(DEVELOPMENT_LANGUAGE).lproj/Documentation",
    MODULES_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Modules",
    JAVA_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Java",
    INFOSTRINGS_PATH: "$(CONTENTS_FOLDER_PATH)/$(DEVELOPMENT_LANGUAGE).lproj/InfoPlist.strings",
    LOCALIZED_RESOURCES_FOLDER_PATH: "$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/$(DEVELOPMENT_LANGUAGE).lproj",
    SHARED_SUPPORT_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/SharedSupport",
    SCRIPTS_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Scripts",
    PBDEVELOPMENTPLIST_PATH: "$(WRAPPER_NAME)/pbdevelopment.plist",
    PKGINFO_PATH: "$(WRAPPER_NAME)/PkgInfo",
    PKGINFO_FILE_PATH: "$(TARGET_TEMP_DIR)/PkgInfo",
    PRODUCT_SETTINGS_PATH: "$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",
    VERSIONPLIST_PATH: "$(WRAPPER_NAME)/version.plist",
    WRAPPER_SUFFIX: productInfo.wrapperExtension ? `.${productInfo.wrapperExtension}` : "",
    EXTENSIONS_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/Extensions",
    SYSTEM_EXTENSIONS_FOLDER_PATH: "$(CONTENTS_FOLDER_PATH)/SystemExtensions",
    PACKAGE_TYPE: productInfo.kind === "application"
      ? "com.apple.package-type.wrapper.application"
      : productInfo.kind === "unit-test"
        ? "com.apple.package-type.bundle.unit-test"
        : productInfo.kind === "framework"
          ? "com.apple.package-type.wrapper.framework"
          : "",
    VERSION_INFO_FILE: "$(PRODUCT_NAME)_vers.c",
    VERSION_INFO_BUILDER: "$(ALTERNATE_OWNER)",
    LOCROOT: projectDir,
    LOCSYMROOT: projectDir,
    PER_ARCH_MODULE_FILE_DIR: "$(TARGET_TEMP_DIR)/Objects-normal/$(CURRENT_ARCH)",
    PER_ARCH_OBJECT_FILE_DIR: "$(OBJECT_FILE_DIR_normal)/$(CURRENT_ARCH)",
    PER_VARIANT_OBJECT_FILE_DIR: "$(OBJECT_FILE_DIR_normal)",
    LLVM_TARGET_TRIPLE_OS_VERSION: `${platform === "macosx" ? "macosx" : platform === "iphonesimulator" || platform === "iphoneos" ? "ios" : platform}$(DEPLOYMENT_TARGET)`,
    SWIFT_PLATFORM_TARGET_PREFIX: platform === "iphonesimulator" || platform === "iphoneos" ? "ios" : platform,
    MODULE_CACHE_DIR: join(objRoot, "ModuleCache.noindex"),
    TESTING_SEARCH_PATHS: "",
    PROJECT_DIR: projectDir,
    SRCROOT: projectDir,
    SOURCE_ROOT: projectDir,
    PROJECT_FILE_PATH: projectPath,
    PROJECT_NAME: project.name,
    PROJECT: project.name,
    PROJECT_GUID: project.rootObject ?? "",
    TARGET_NAME: target?.name ?? project.name,
    TARGETNAME: target?.name ?? project.name,
    PRODUCT_NAME: productName,
    PRODUCT_MODULE_NAME: "$(PRODUCT_NAME:c99extidentifier)",
    SWIFT_MODULE_NAME: "$(PRODUCT_MODULE_NAME)",
    FULL_PRODUCT_NAME: "$(WRAPPER_NAME)",
    WRAPPER_NAME: productInfo.executablePrefix
      ? "$(EXECUTABLE_NAME)"
      : productInfo.wrapperExtension.length > 0
        ? "$(PRODUCT_NAME).$(WRAPPER_EXTENSION)"
        : "$(PRODUCT_NAME)",
    EXECUTABLE_PREFIX: productInfo.executablePrefix ?? "",
    EXECUTABLE_EXTENSION: productInfo.wrapperExtension === "a" ? "a" : "",
    EXECUTABLE_NAME: "$(EXECUTABLE_PREFIX)$(PRODUCT_NAME)$(EXECUTABLE_EXTENSION)",
    WRAPPER_EXTENSION: productInfo.wrapperExtension,
    PRODUCT_BUNDLE_PACKAGE_TYPE: productInfo.packageType,
    MACH_O_TYPE: productInfo.machOType,
    EXECUTABLE_PATH: productInfo.executablePath,
    INFOPLIST_PATH: productInfo.infoplistPath,
    SKIP_INSTALL: productInfo.skipInstall,
    ARCHS: archs,
    CURRENT_ARCH: arch,
    HOST_ARCH: hostArch,
    DEVELOPER_DIR: developerDir ?? "",
    ...xcodeVersionSettings(xcodeVersion, xcodeBuild),
    TOOLCHAIN_DIR: developerDir ? join(developerDir, "Toolchains", "XcodeDefault.xctoolchain") : "",
    DT_TOOLCHAIN_DIR: "$(TOOLCHAIN_DIR)",
    DEVELOPER_FRAMEWORKS_DIR_QUOTED: "$(DEVELOPER_FRAMEWORKS_DIR)",
    EFFECTIVE_SWIFT_VERSION: "$(SWIFT_VERSION)",
    PLATFORM_NAME: platform,
    SDKROOT: sdk?.path ?? SDKROOT_NAME[platform] ?? platform,
    SDK_NAME: sdk?.name ?? SDKROOT_NAME[platform] ?? platform,
    SDK_NAMES: "$(SDK_NAME)",
    SDK_VERSION: sdk?.version ?? "",
    HOST_PLATFORM: "macosx",
    DYNAMIC_LIBRARY_EXTENSION: "dylib",
    arch: "$(CURRENT_ARCH)",
    variant: "$(CURRENT_VARIANT)",
    SDK_DIR: sdk?.path ?? "",
    LANGUAGE: project.developmentRegion || "en",
    DEVELOPMENT_LANGUAGE: project.developmentRegion || "en",
    PRODUCT_TYPE: target?.productType ?? "",
    ...configurationDefaults,
    ...productInfo.extra,
    GENERATE_INFOPLIST_FILE: productInfo.extra.GENERATE_INFOPLIST_FILE ?? "NO",
    INFOPLIST_FILE: "",
    CODE_SIGN_STYLE: "Automatic",
    CODE_SIGN_ENTITLEMENTS: "",
    CODE_SIGNING_REQUIRED: "YES",
    CODE_SIGNING_ALLOWED: "YES",
    CODE_SIGN_IDENTITY: "-",
    DEVELOPMENT_TEAM: "",
    PROVISIONING_PROFILE_SPECIFIER: "",
    ENTITLEMENTS_REQUIRED: "NO",
    LIBRARY_FLAG_PREFIX: "-l",
    GCC_VERSION: "com.apple.compilers.llvm.clang.1_0",
    GCC_VERSION_IDENTIFIER: "com_apple_compilers_llvm_clang_1_0",
    GCC_INLINES_ARE_PRIVATE_EXTERN: "YES",
    GCC_OBJC_LEGACY_DISPATCH: "YES",
    GCC_WARN_64_TO_32_BIT_CONVERSION: "NO",
    LD_RUNPATH_SEARCH_PATHS: productInfo.kind === "unit-test"
      ? "@loader_path/Frameworks @executable_path/Frameworks"
      : (productInfo.runpath ?? ""),
    LD_EXPORT_GLOBAL_SYMBOLS: "YES",
    _SWIFT_EXPLICIT_MODULES_ALLOW_CXX_INTEROP: "YES",
    SWIFT_ENABLE_EXPLICIT_MODULES: "YES",
    SWIFTC_PASS_SYSROOT: "NO",
    TOOLCHAINS: "com.apple.dt.toolchain.XcodeDefault",
    FRAMEWORK_FLAG_PREFIX: "-framework",
    ENABLE_THREAD_SANITIZER: "NO",
    CLANG_CACHE_FINE_GRAINED_OUTPUTS: "NO",
    JAVA_APP_STUB: "/System/Library/Frameworks/JavaVM.framework/Resources/MacOS/JavaApplicationStub",
    SYSTEM_LIBRARY_DIR: "/System/Library",
    LOCAL_LIBRARY_DIR: "/Library",
    LOCAL_APPS_DIR: "/Applications",
    LOCAL_ADMIN_APPS_DIR: "/Applications/Utilities",
    SYSTEM_APPS_DIR: "/Applications",
    SYSTEM_ADMIN_APPS_DIR: "/Applications/Utilities",
    DEFAULT_COMPILER: "com.apple.compilers.llvm.clang.1_0",
    INFOPLIST_OUTPUT_FORMAT: "binary",
    PLIST_FILE_OUTPUT_FORMAT: "binary",
    STRINGS_FILE_OUTPUT_ENCODING: "binary",
    SYSTEM_DEXT_INSTALL_PATH: "/System/Library/DriverExtensions",
    SYSTEM_KEXT_INSTALL_PATH: "/System/Library/Extensions",
    LIBRARY_DEXT_INSTALL_PATH: "/Library/DriverExtensions",
    LIBRARY_KEXT_INSTALL_PATH: "/Library/Extensions",
    INSTALL_PATH: productInfo.kind === "application" ? "/Applications" : "",
    INSTALL_DIR: productInfo.kind === "application" ? "/tmp/$(PRODUCT_NAME).dst/Applications" : "/tmp/$(PRODUCT_NAME).dst",
    FRAMEWORK_SEARCH_PATHS: "$(BUILT_PRODUCTS_DIR) $(inherited)",
    HEADER_SEARCH_PATHS: "$(BUILT_PRODUCTS_DIR)/include $(inherited)",
    LIBRARY_SEARCH_PATHS: "$(BUILT_PRODUCTS_DIR) $(inherited)",
    REZ_SEARCH_PATHS: "$(BUILT_PRODUCTS_DIR) $(inherited)",
    PATH_PREFIXES_EXCLUDED_FROM_HEADER_DEPENDENCIES: [
      "/usr/include", "/usr/local/include", "/System/Library/Frameworks",
      "/System/Library/PrivateFrameworks", "$(DEVELOPER_DIR)/Headers",
      "$(DEVELOPER_DIR)/SDKs", "$(DEVELOPER_DIR)/Platforms",
    ].join(" "),
    ALWAYS_SEARCH_USER_PATHS: "NO",
    CLANG_ANALYZER_NONNULL: "YES",
    CLANG_ANALYZER_NUMBER_OBJECT_CONVERSION: "YES_AGGRESSIVE",
    CLANG_CXX_LANGUAGE_STANDARD: "gnu++20",
    CLANG_ENABLE_MODULES: "YES",
    CLANG_ENABLE_OBJC_ARC: "YES",
    CLANG_ENABLE_OBJC_WEAK: "YES",
    CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING: "YES",
    CLANG_WARN_BOOL_CONVERSION: "YES",
    CLANG_WARN_COMMA: "YES",
    CLANG_WARN_CONSTANT_CONVERSION: "YES",
    CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS: "YES",
    CLANG_WARN_DIRECT_OBJC_ISA_USAGE: "YES_ERROR",
    CLANG_WARN_DOCUMENTATION_COMMENTS: "YES",
    CLANG_WARN_EMPTY_BODY: "YES",
    CLANG_WARN_ENUM_CONVERSION: "YES",
    CLANG_WARN_INFINITE_RECURSION: "YES",
    CLANG_WARN_INT_CONVERSION: "YES",
    CLANG_WARN_NON_LITERAL_NULL_CONVERSION: "YES",
    CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF: "YES",
    CLANG_WARN_OBJC_LITERAL_CONVERSION: "YES",
    CLANG_WARN_OBJC_ROOT_CLASS: "YES_ERROR",
    CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: "YES",
    CLANG_WARN_RANGE_LOOP_ANALYSIS: "YES",
    CLANG_WARN_STRICT_PROTOTYPES: "YES",
    CLANG_WARN_SUSPICIOUS_MOVE: "YES",
    CLANG_WARN_UNGUARDED_AVAILABILITY: "YES_AGGRESSIVE",
    CLANG_WARN_UNREACHABLE_CODE: "YES",
    CLANG_WARN__DUPLICATE_METHOD_MATCH: "YES",
    COPY_PHASE_STRIP: "NO",
    DEBUG_INFORMATION_FORMAT: "dwarf",
    ENABLE_STRICT_OBJC_MSGSEND: "YES",
    ENABLE_TESTABILITY: "NO",
    ENABLE_USER_SCRIPT_SANDBOXING: "NO",
    SWIFT_ENABLE_TESTABILITY: "$(ENABLE_TESTABILITY)",
    GCC_C_LANGUAGE_STANDARD: "gnu17",
    GCC_NO_COMMON_BLOCKS: "YES",
    GCC_WARN_ABOUT_RETURN_TYPE: "YES_ERROR",
    GCC_WARN_UNDECLARED_SELECTOR: "YES",
    GCC_WARN_UNINITIALIZED_AUTOS: "YES_AGGRESSIVE",
    GCC_WARN_UNUSED_FUNCTION: "YES",
    GCC_WARN_UNUSED_VARIABLE: "YES",
    MTL_ENABLE_DEBUG_INFO: "NO",
    MTL_FAST_MATH: "YES",
    SWIFT_VERSION: "5.0",
    SWIFT_EMIT_LOC_STRINGS: "YES",
    SWIFT_STRICT_CONCURRENCY: "minimal",
    SWIFT_OBJC_BRIDGING_HEADER: "",
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited)",
    SWIFT_INSTALL_OBJC_HEADER: "YES",
    STRIP_INSTALLED_PRODUCT: "NO",
    SUPPORTED_PLATFORMS: SUPPORTED_PLATFORMS[platform] ?? platform,
    TARGETED_DEVICE_FAMILY: "1,2",
    VERSIONING_SYSTEM: "apple-generic",
    MARKETING_VERSION: "1.0",
    CURRENT_PROJECT_VERSION: "1",
    ASSETCATALOG_COMPILER_APPICON_NAME: "",
    SWIFT_INCLUDE_PATHS: "$(inherited)",
    OTHER_LDFLAGS: "$(inherited)",
    OTHER_SWIFT_FLAGS: "$(inherited)",
    OTHER_CFLAGS: "$(inherited)",
    OTHER_CPLUSPLUSFLAGS: "$(inherited)",
    ...platformDefaults({
      platform,
      sdk,
      hostArch,
      sdkDir: context.sdkDir,
      developerDir,
    }),
    ...bundleLayoutDefaults(platform, productInfo),
    // SDK DefaultProperties can declare requirements for device signing. The
    // simulator query must not inherit an unconditional device entitlements flag.
    ...(platform.endsWith("simulator") ? {
      ENTITLEMENTS_REQUIRED: "NO",
      SWIFTC_PASS_SYSROOT: "NO",
    } : {}),
    ...hostAccountSettings(),
    ...hostMacOSVersionSettings(),
    ...hostXcodeCacheSettings({ version: xcodeVersion, build: xcodeBuild }),
  };
}

export function deploymentTargetSetting(platform) {
  return DEPLOYMENT_TARGET_SETTING[platform] ?? "DEPLOYMENT_TARGET";
}
