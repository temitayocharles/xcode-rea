import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sha256 } from "../util/text.js";
import { productTypeInfo } from "./productTypes.js";

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
      return hostArch === "arm64" ? "arm64" : "x86_64";
    case "macosx":
      return "arm64 x86_64";
    case "appletvos":
      return "arm64";
    case "appletvsimulator":
      return hostArch === "arm64" ? "arm64" : "x86_64";
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
    return layout;
  }

  const layout = {
    CONTENTS_FOLDER_PATH: "$(WRAPPER_NAME)",
    UNLOCALIZED_RESOURCES_FOLDER_PATH: "$(WRAPPER_NAME)",
    FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/Frameworks",
    PLUGINS_FOLDER_PATH: "$(WRAPPER_NAME)/PlugIns",
    SHARED_FRAMEWORKS_FOLDER_PATH: "$(WRAPPER_NAME)/SharedFrameworks",
  };
  return layout;
}

export function platformDefaults(context) {
  const { platform, sdk, hostArch, sdkDir, developerDir } = context;
  const sdkRoot = SDKROOT_NAME[platform] ?? platform;
  const deploymentSetting = DEPLOYMENT_TARGET_SETTING[platform] ?? "DEPLOYMENT_TARGET";
  const sdkDefaults = sdk?.defaultProperties ?? {};
  const deploymentTarget =
    sdkDefaults[deploymentSetting] ?? MINIMUM_DEPLOYMENT_TARGET[platform] ?? "1.0";
  const platformDir = developerDir ? join(developerDir, "Platforms", `${PLATFORM_DIR_NAME[platform] ?? platform}.platform`) : "";
  const standardArch = standardArchitectures(platform, hostArch);

  const defaults = {
    SDKROOT: sdkRoot,
    PLATFORM_NAME: platform,
    EFFECTIVE_PLATFORM_NAME: effectivePlatformName(platform),
    SUPPORTED_PLATFORMS: SUPPORTED_PLATFORMS[platform] ?? platform,
    [deploymentSetting]: deploymentTarget,
    DEPLOYMENT_TARGET: `$(${deploymentSetting})`,
    MINIMUM_DEPLOYMENT_TARGET: deploymentTarget,
    ARCHS_STANDARD: standardArch,
    VALID_ARCHS: standardArch,
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
  } else {
    defaults.SDK_NAME = sdkRoot;
  }
  if (platformDir) defaults.PLATFORM_DIR = platformDir;

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
    CONFIGURATION_BUILD_DIR: "$(BUILT_PRODUCTS_DIR)",
    BUILT_PRODUCTS_DIR: productsDir,
    TARGET_BUILD_DIR: "$(BUILT_PRODUCTS_DIR)",
    BUILD_DIR: productsDir,
    SYMROOT: dirname(productsDir),
    OBJROOT: objRoot,
    CONFIGURATION_TEMP_DIR: configurationTemp,
    TARGET_TEMP_DIR: targetTemp,
    DERIVED_FILE_DIR: targetTemp,
    DERIVED_FILES_DIR: targetTemp,
    SHARED_DERIVED_FILE_DIR: "$(DERIVED_FILE_DIR)/Shared",
    MODULE_CACHE_DIR: join(objRoot, "ModuleCache.noindex"),
    PROJECT_DIR: projectDir,
    SRCROOT: projectDir,
    SOURCE_ROOT: projectDir,
    PROJECT_FILE_PATH: projectPath,
    PROJECT_NAME: project.name,
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
    PLATFORM_NAME: platform,
    SDKROOT: SDKROOT_NAME[platform] ?? platform,
    SDK_NAME: sdk?.name ?? SDKROOT_NAME[platform] ?? platform,
    SDK_VERSION: sdk?.version ?? "",
    SDK_DIR: sdk?.path ?? "",
    LANGUAGE: "en",
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
    GCC_C_LANGUAGE_STANDARD: "gnu17",
    GCC_NO_COMMON_BLOCKS: "YES",
    GCC_WARN_64_TO_32_BIT_CONVERSION: "YES",
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
    FRAMEWORK_SEARCH_PATHS: "$(inherited)",
    HEADER_SEARCH_PATHS: "$(inherited)",
    LIBRARY_SEARCH_PATHS: "$(inherited)",
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
  };
}

export function deploymentTargetSetting(platform) {
  return DEPLOYMENT_TARGET_SETTING[platform] ?? "DEPLOYMENT_TARGET";
}
