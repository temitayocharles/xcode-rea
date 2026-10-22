import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadProject } from "../src/xcode/pbxproj.js";
import { expandSettings, matchConditions, resolveBuildSettings } from "../src/settings/resolver.js";
import { genericDefaults, defaultDerivedDataPath, sdkVersionSettings, xcodeProjectGuid, derivedArchitectureFileLists, xcode271ObservedDeploymentDefaults } from "../src/settings/defaults.js";
import { productTypeInfo } from "../src/settings/productTypes.js";
import { parsePlist } from "../src/plist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

function settingsFor({ projectPath, targetName, configuration = "Debug", platform = "iphonesimulator", arch = "arm64", overrides = {}, sdk, xcodeVersion = null }) {
  const project = loadProject(projectPath);
  const target = targetName ? project.targetByName(targetName) : null;
  return resolveBuildSettings({
    project,
    target,
    configuration,
    platform,
    sdk: sdk ?? {
      name: `${platform}18.0`,
      version: "18.0",
      path: `/SDK/${platform}.sdk`,
      root: platform,
      defaultProperties: {},
    },
    arch,
    hostArch: "arm64",
    derivedDataPath: "/tmp/DerivedData",
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    xcodeVersion,
    overrides: { SDKROOT: platform, ...overrides },
  });
}

test("Xcode PROJECT_GUID is the MD5 of the project bundle name, not PBX rootObject", () => {
  assert.equal(xcodeProjectGuid("/tmp/A/Zotero.xcodeproj"),
    "58a3ba8f89924aadaccf2ef83a272a88");
  assert.equal(xcodeProjectGuid("/tmp/B/places.xcodeproj"),
    "14a86506a56eb18b25d41e9dce5b262c");
  assert.equal(xcodeProjectGuid("/tmp/A/HelloXcode.xcodeproj/project.pbxproj"),
    "4a043c181975a0b357f9ef73e27983fc");
  assert.equal(xcodeProjectGuid("/tmp/not-a-project"), "");
});

test("architecture intermediate file lists derive from build variant and arch set", () => {
  const list = derivedArchitectureFileLists(["arm64", "x86_64"], "normal");
  assert.equal(list.LINK_FILE_LIST_normal_arm64,
    "$(OBJECT_FILE_DIR_normal)/arm64/$(TARGET_NAME).LinkFileList");
  assert.equal(list.SWIFT_RESPONSE_FILE_PATH_normal_x86_64,
    "$(OBJECT_FILE_DIR_normal)/x86_64/$(TARGET_NAME).SwiftFileList");
  assert.equal(list.LM_AUX_CONST_METADATA_LIST_PATH_normal_arm64,
    "$(OBJECT_FILE_DIR_normal)/arm64/$(TARGET_NAME).SwiftConstValuesFileList");
  assert.deepEqual(derivedArchitectureFileLists(["arm64;rm -rf /"], "normal"), {});
});

test("SDK version numbers follow Xcode's major-minor-patch format", () => {
  assert.deepEqual(sdkVersionSettings("27.1"), {
    SDK_VERSION_ACTUAL: "270100",
    SDK_VERSION_MAJOR: "270000",
    SDK_VERSION_MINOR: "270100",
  });
  assert.deepEqual(sdkVersionSettings("17.2.1"), {
    SDK_VERSION_ACTUAL: "170201",
    SDK_VERSION_MAJOR: "170000",
    SDK_VERSION_MINOR: "170201",
  });
  assert.deepEqual(sdkVersionSettings("unknown"), {});
});

test("platform condition selectors follow the selected SDK family", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  const simulator = settingsFor({
    projectPath, targetName: "HelloXcode", platform: "iphonesimulator",
  }).settings;
  assert.equal(simulator.__IS_NOT_MACOS, "YES");
  assert.equal(simulator.__IS_NOT_MACOS_macosx, "NO");
  assert.equal(simulator.__IS_NOT_SIMULATOR, "NO");
  assert.equal(simulator.__IS_NOT_SIMULATOR_simulator, "NO");
  assert.equal(simulator.__ORIGINAL_SDK_DEFINED_LLVM_TARGET_TRIPLE_SYS, "ios");
  const device = settingsFor({
    projectPath, targetName: "HelloXcode", platform: "iphoneos",
  }).settings;
  assert.equal(device.__IS_NOT_MACOS, "YES");
  assert.equal(device.__IS_NOT_SIMULATOR, "YES");
  assert.equal(device.__ORIGINAL_SDK_DEFINED_LLVM_TARGET_TRIPLE_SYS, "ios");
  assert.equal(device.__ARCHS__, undefined);
});

test("Xcode 27.1 simulator __ARCHS__ follows the effective architecture set", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  for (const targetName of ["HelloXcode", "HelloXcodeTests"]) {
    const settings = settingsFor({ projectPath, targetName, xcodeVersion: "27.1" }).settings;
    assert.equal(settings.__ARCHS__, "arm64 x86_64");
    assert.equal(settings.__ARCHS__, settings.ARCHS);
    const overridden = settingsFor({ projectPath, targetName, xcodeVersion: "27.1",
      overrides: { ARCHS: "arm64" } }).settings;
    assert.equal(overridden.__ARCHS__, "arm64");
    const explicit = settingsFor({ projectPath, targetName, xcodeVersion: "27.1",
      overrides: { ARCHS: "arm64", __ARCHS__: "custom" } }).settings;
    assert.equal(explicit.__ARCHS__, "custom");
    const older = settingsFor({ projectPath, targetName, xcodeVersion: "26.4" }).settings;
    assert.equal(older.__ARCHS__, undefined);
  }
});

test("measured cross-platform deployment defaults apply to Xcode 27.1 only", () => {
  const measured = xcode271ObservedDeploymentDefaults("27.1");
  assert.deepEqual(measured, {
    ANDROID_DEPLOYMENT_TARGET: "21.0",
    DRIVERKIT_DEPLOYMENT_TARGET: "27.0",
    MACOSX_DEPLOYMENT_TARGET: "27.0",
    TVOS_DEPLOYMENT_TARGET: "27.0",
    WATCHOS_DEPLOYMENT_TARGET: "27.0",
    XROS_DEPLOYMENT_TARGET: "27.0",
  });
  for (const version of [null, "26.4", "27.0", "27.2"]) {
    assert.deepEqual(xcode271ObservedDeploymentDefaults(version), {});
  }
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const options = {
    project, target, configuration: "Debug", platform: "iphonesimulator",
    sdk: { path: "/SDK/iPhoneSimulator27.1.sdk", name: "iphonesimulator27.1",
      version: "27.1", root: "iphonesimulator", defaultProperties: {} },
    arch: "arm64", hostArch: "arm64", derivedDataPath: "/tmp/xcl-measured",
    developerDir: "/Developer", xcodeVersion: "27.1",
  };
  const resolved = resolveBuildSettings(options).settings;
  for (const [name, value] of Object.entries(measured)) {
    assert.equal(resolved[name], value, name);
  }
  const overridden = resolveBuildSettings({
    ...options, overrides: { DRIVERKIT_DEPLOYMENT_TARGET: "custom-value" },
  }).settings;
  assert.equal(overridden.DRIVERKIT_DEPLOYMENT_TARGET, "custom-value");
});

test("HelloXcode Debug simulator settings", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcode",
  });
  assert.match(settings.BUILT_PRODUCTS_DIR, /DerivedData\/Build\/Products\/Debug-iphonesimulator$/);
  assert.equal(settings.PROJECT_TEMP_DIR, "/tmp/DerivedData/Build/Intermediates.noindex/HelloXcode.build");
  assert.equal(settings.DERIVED_FILE_DIR,
    "/tmp/DerivedData/Build/Intermediates.noindex/HelloXcode.build/Debug-iphonesimulator/HelloXcode.build/DerivedSources");
  assert.equal(settings.DERIVED_FILES_DIR, settings.DERIVED_FILE_DIR);
  assert.equal(settings.SHARED_DERIVED_FILE_DIR, settings.BUILT_PRODUCTS_DIR + "/DerivedSources");
  assert.equal(settings.SDK_VERSION_ACTUAL, "180000");
  assert.equal(settings.SDK_VERSION_MAJOR, "180000");
  assert.equal(settings.SDK_VERSION_MINOR, "180000");
  assert.equal(settings.SDK_DIR_iphonesimulator, "/SDK/iphonesimulator.sdk");
  assert.equal(settings.PLATFORM_DISPLAY_NAME, "iOS Simulator");
  assert.equal(settings.PLATFORM_FAMILY_NAME, "iOS");
  assert.equal(settings.DERIVED_SOURCES_DIR, settings.DERIVED_FILE_DIR);
  assert.ok(settings.OBJECT_FILE_DIR_normal.endsWith("/HelloXcode.build/Objects-normal"));
  assert.ok(settings.FIXED_FILES_DIR.endsWith("/HelloXcode.build/FixedFiles"));
  assert.equal(settings.DWARF_DSYM_FOLDER_PATH, settings.BUILT_PRODUCTS_DIR);
  assert.equal(settings.EXECUTABLE_FOLDER_PATH, "HelloXcode.app");
  assert.equal(settings.PUBLIC_HEADERS_FOLDER_PATH, "HelloXcode.app/Headers");
  assert.equal(settings.PRIVATE_HEADERS_FOLDER_PATH, "HelloXcode.app/PrivateHeaders");
  assert.equal(settings.SHALLOW_BUNDLE, "YES");
  assert.equal(settings.SHALLOW_BUNDLE_TRIPLE, "ios-simulator");
  assert.equal(settings.SHALLOW_BUNDLE_ios_macabi, "NO");
  assert.equal(settings.SHALLOW_BUNDLE_macos, "NO");
  assert.equal(settings.CONTENTS_FOLDER_PATH_SHALLOW_BUNDLE_NO, "HelloXcode.app/Contents");
  assert.equal(settings.CONTENTS_FOLDER_PATH_SHALLOW_BUNDLE_YES, "HelloXcode.app");
  assert.equal(settings.EXECUTABLE_FOLDER_PATH_SHALLOW_BUNDLE_NO, "HelloXcode.app/MacOS");
  assert.equal(settings.EXECUTABLE_FOLDER_PATH_SHALLOW_BUNDLE_YES, "HelloXcode.app");
  assert.equal(settings.SYSTEM_DEVELOPER_DEMOS_DIR,
    settings.DEVELOPER_DIR + "/Applications/Utilities/Built Examples");
  assert.equal(settings.SYSTEM_DEVELOPER_DOC_DIR,
    settings.DEVELOPER_DIR + "/ADC Reference Library");
  assert.equal(settings.SYSTEM_DEVELOPER_GRAPHICS_TOOLS_DIR,
    settings.DEVELOPER_DIR + "/Applications/Graphics Tools");
  assert.equal(settings.SYSTEM_DEVELOPER_JAVA_TOOLS_DIR,
    settings.DEVELOPER_DIR + "/Applications/Java Tools");
  assert.equal(settings.SYSTEM_DEVELOPER_PERFORMANCE_TOOLS_DIR,
    settings.DEVELOPER_DIR + "/Applications/Performance Tools");
  assert.equal(settings.SYSTEM_DEVELOPER_USR_DIR, settings.DEVELOPER_USR_DIR);
  assert.equal(settings.SYSTEM_DOCUMENTATION_DIR, "/Library/Documentation");
  assert.equal(settings.USER_APPS_DIR, settings.HOME + "/Applications");
  assert.equal(settings.USER_LIBRARY_DIR, settings.HOME + "/Library");
  assert.equal(settings.SYSTEM_EXTENSIONS_FOLDER_PATH_SHALLOW_BUNDLE_NO,
    "HelloXcode.app/Library/SystemExtensions");
  assert.equal(settings.SYSTEM_EXTENSIONS_FOLDER_PATH_SHALLOW_BUNDLE_YES,
    "HelloXcode.app/SystemExtensions");
  assert.equal(settings.SUPPORTS_ON_DEMAND_RESOURCES, "YES");
  assert.equal(settings.LINK_OBJC_RUNTIME, "YES");
  assert.equal(settings.NATIVE_ARCH_32_BIT, "arm");
  assert.equal(settings.NATIVE_ARCH_64_BIT, "arm64");
  assert.equal(settings.LEGACY_DEVELOPER_DIR,
    join(settings.DEVELOPER_DIR, "..", "PlugIns",
      "Xcode3Core.ideplugin", "Contents", "SharedSupport", "Developer"));
  assert.equal(settings.XCODE_APP_SUPPORT_DIR,
    settings.DEVELOPER_DIR + "/Library/Xcode");
  for (const architecture of ["arm64", "x86_64"]) {
    const dir = settings.OBJECT_FILE_DIR_normal + "/" + architecture;
    assert.equal(settings["LINK_FILE_LIST_normal_" + architecture],
      dir + "/HelloXcode.LinkFileList");
    assert.equal(settings["SWIFT_RESPONSE_FILE_PATH_normal_" + architecture],
      dir + "/HelloXcode.SwiftFileList");
    assert.equal(settings["LM_AUX_CONST_METADATA_LIST_PATH_normal_" + architecture],
      dir + "/HelloXcode.SwiftConstValuesFileList");
  }
  assert.equal(settings.LOCALIZED_RESOURCES_FOLDER_PATH, "HelloXcode.app/en.lproj");
  assert.equal(settings.DEVELOPMENT_LANGUAGE, "en");
  const fixtureProject = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  assert.equal(settings.PROJECT, fixtureProject.name);
  assert.equal(settings.PROJECT_GUID, "4a043c181975a0b357f9ef73e27983fc");
  assert.equal(settings.WORKSPACE_DIR, fixture("HelloXcode/HelloXcode.xcodeproj"));
  assert.equal(settings._WRAPPER_CONTENTS_DIR_SHALLOW_BUNDLE_NO, "/Contents");
  assert.equal(settings._WRAPPER_PARENT_PATH_SHALLOW_BUNDLE_NO, "/..");
  assert.equal(settings._WRAPPER_RESOURCES_DIR_SHALLOW_BUNDLE_NO, "/Resources");
  assert.equal(settings.PROVISIONING_PROFILE_REQUIRED, "NO");
  assert.equal(settings.PROVISIONING_PROFILE_SUPPORTED, "YES");
  assert.equal(settings.ARCHS, "arm64 x86_64");
  assert.equal(settings.ARCHS_STANDARD_32_64_BIT, "arm64 x86_64");
  assert.equal(settings.ARCHS_UNIVERSAL_IPHONE_OS, "arm64 x86_64");
  assert.equal(settings.ONLY_ARCH, "multiple_archs");
  assert.equal(settings.ONLY_ACTIVE_ARCH, "YES");
  assert.equal(settings.RPATH_ORIGIN, "@loader_path");
  assert.equal(settings.RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET, "17.0");
  assert.equal(settings.PLATFORM_REQUIRES_SWIFT_AUTOLINK_EXTRACT, "NO");
  assert.equal(settings.PLATFORM_REQUIRES_SWIFT_MODULEWRAP, "NO");
  assert.equal(settings.PLATFORM_USES_DSYMS, "YES");
  assert.equal(settings.COMPILATION_CACHE_KEEP_CAS_DIRECTORY, "YES");
  assert.equal(settings.SCANNING_PCM_KEEP_CACHE_DIRECTORY, "YES");
  assert.equal(settings.VALIDATE_DEVELOPMENT_ASSET_PATHS, "YES_ERROR");
  assert.equal(settings.SKIP_COPYING_TEST_FRAMEWORKS, "YES");
  assert.equal(settings.DIAGNOSE_MISSING_TARGET_DEPENDENCIES, "YES");
  assert.equal(settings.ENABLE_DEBUG_DYLIB, "YES");
  assert.equal(settings.SWIFT_OPTIMIZATION_LEVEL, "-Onone");
  assert.equal(settings.IS_UNOPTIMIZED_BUILD, "YES");
  assert.equal(settings.ENABLE_TESTABILITY, "YES");
  assert.equal(settings.SWIFT_VERSION, "5.0");
  assert.equal(settings.PRODUCT_NAME, "HelloXcode");
  assert.equal(settings.PRODUCT_MODULE_NAME, "HelloXcode");
  assert.equal(settings.WRAPPER_NAME, "HelloXcode.app");
  assert.equal(settings.EXECUTABLE_PATH, "HelloXcode.app/HelloXcode");
  assert.equal(settings.INFOPLIST_PATH, "HelloXcode.app/Info.plist");
  assert.equal(settings.DEPLOYMENT_TARGET, "17.0");
  assert.equal(settings.SDKROOT, "iphonesimulator");
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "com.example.HelloXcode");
  assert.equal(settings.GCC_PREPROCESSOR_DEFINITIONS, "DEBUG=1 ");
  assert.equal(settings.EFFECTIVE_PLATFORM_NAME, "-iphonesimulator");
});

test("explicit workspace builds use the workspace container, not the first project", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const workspacePath = "/tmp/MultipleApps.xcworkspace";
  const { settings } = resolveBuildSettings({
    project, workspacePath, target,
    configuration: "Debug", platform: "iphonesimulator",
    sdk: { name: "iphonesimulator27.1", version: "27.1",
      path: "/SDK/iPhoneSimulator27.1.sdk", root: "iphonesimulator",
      defaultProperties: {} },
    arch: "arm64", hostArch: "arm64", derivedDataPath: "/tmp/WorkspaceDerived",
    developerDir: "/Developer",
  });
  assert.equal(settings.PROJECT_FILE_PATH, project.path);
  assert.equal(settings.WORKSPACE_DIR, workspacePath);
  const overridden = resolveBuildSettings({
    project, workspacePath, target, configuration: "Debug",
    platform: "iphonesimulator", arch: "arm64",
    derivedDataPath: "/tmp/WorkspaceDerived", developerDir: "/Developer",
    overrides: { WORKSPACE_DIR: "/tmp/Override.xcworkspace" },
  });
  assert.equal(overridden.settings.WORKSPACE_DIR, "/tmp/Override.xcworkspace");
});

test("Xcode 27.1 simulator settings are derived from context, not fixture paths", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcode",
  });
  assert.equal(settings.PLATFORM_PREFERRED_ARCH, "x86_64");
  assert.equal(settings.DOCUMENTATION_FOLDER_PATH, "HelloXcode.app/en.lproj/Documentation");
  assert.equal(settings.INFOSTRINGS_PATH, "HelloXcode.app/en.lproj/InfoPlist.strings");
  assert.equal(settings.ENTITLEMENTS_REQUIRED, "NO");
  assert.equal(settings.SDK_NAMES, "iphonesimulator18.0");
  assert.equal(settings.EFFECTIVE_SWIFT_VERSION, "5");
  assert.equal(settings.DT_TOOLCHAIN_DIR, settings.TOOLCHAIN_DIR);
  assert.equal(settings.DEVELOPER_FRAMEWORKS_DIR_QUOTED, settings.DEVELOPER_FRAMEWORKS_DIR);
  assert.equal(settings.PKGINFO_FILE_PATH,
    settings.TARGET_TEMP_DIR + "/PkgInfo");
  assert.equal(settings.PER_VARIANT_OBJECT_FILE_DIR, settings.OBJECT_FILE_DIR_normal);
  assert.equal(settings.SYSTEM_ADMIN_APPS_DIR, "/Applications/Utilities");
  assert.equal(settings.SYSTEM_APPS_DIR, "/Applications");
  assert.equal(settings.SYSTEM_CORE_SERVICES_DIR, "/System/Library/CoreServices");
  assert.equal(settings.SYSTEM_DEMOS_DIR, "/Applications/Extras");
  assert.equal(settings.LOCAL_DEVELOPER_DIR, "/Library/Developer");
  assert.equal(settings.OS, "MACOS");
  assert.equal(settings.SYSTEM_DEVELOPER_DIR, settings.DEVELOPER_DIR);
  assert.equal(settings.SYSTEM_DEVELOPER_APPS_DIR, settings.DEVELOPER_APPLICATIONS_DIR);
  assert.equal(settings.SYSTEM_DEVELOPER_BIN_DIR, settings.DEVELOPER_BIN_DIR);
  assert.equal(settings.SYSTEM_DEVELOPER_TOOLS, settings.DEVELOPER_TOOLS_DIR);
  assert.equal(settings.PRODUCT_SETTINGS_PATH, "");
  assert.equal(settings.SWIFT_ENABLE_EXPLICIT_MODULES, "YES");
  assert.equal(settings._SWIFT_EXPLICIT_MODULES_ALLOW_CXX_INTEROP, "YES");
  assert.equal(settings.CLANG_CACHE_FINE_GRAINED_OUTPUTS, "YES");
  assert.equal(settings.LD_RUNPATH_SEARCH_PATHS, " @executable_path/Frameworks");
  assert.equal(settings.HOST_PLATFORM, "macosx");
  assert.equal(settings.DYNAMIC_LIBRARY_EXTENSION, "dylib");
  assert.equal(settings.arch, "arm64");
  assert.equal(settings.variant, "normal");
  assert.equal(settings.SWIFTC_PASS_SYSROOT, "NO");
  assert.equal(settings.LLVM_TARGET_TRIPLE_OS_VERSION, "ios17.0");
  assert.equal(settings.PACKAGE_TYPE, "com.apple.package-type.wrapper.application");
  assert.equal(settings.WRAPPER_SUFFIX, ".app");
  assert.equal(settings.GCC_VERSION, "com.apple.compilers.llvm.clang.1_0");
  assert.equal(settings.INFOPLIST_OUTPUT_FORMAT, "binary");
  assert.equal(settings.GCC_WARN_64_TO_32_BIT_CONVERSION, "NO");
  assert.equal(settings.ENABLE_ON_DEMAND_RESOURCES, "YES");
  assert.equal(settings.GENERATE_PKGINFO_FILE, "YES");
  assert.equal(settings.SUPPORTS_MACCATALYST, "NO");
  assert.equal(settings.LIBRARY_FLAG_PREFIX, "-l");
  assert.equal(settings.GENERATED_MODULEMAP_DIR,
    "/tmp/DerivedData/Build/Intermediates.noindex/GeneratedModuleMaps-iphonesimulator");
  assert.equal(settings.FRAMEWORK_SEARCH_PATHS, settings.BUILT_PRODUCTS_DIR + " ");
  assert.equal(settings.HEADER_SEARCH_PATHS, settings.BUILT_PRODUCTS_DIR + "/include ");
});

test("IS_UNOPTIMIZED_BUILD follows resolved compiler settings, not configuration names", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  const release = settingsFor({
    projectPath, targetName: "HelloXcode", configuration: "Release",
  }).settings;
  assert.equal(release.IS_UNOPTIMIZED_BUILD, "NO");
  const custom = settingsFor({
    projectPath, targetName: "HelloXcode",
    overrides: { SWIFT_OPTIMIZATION_LEVEL: "-O" },
  }).settings;
  assert.equal(custom.IS_UNOPTIMIZED_BUILD, "NO");
  const explicit = settingsFor({
    projectPath, targetName: "HelloXcode",
    overrides: { IS_UNOPTIMIZED_BUILD: "CUSTOM" },
  }).settings;
  assert.equal(explicit.IS_UNOPTIMIZED_BUILD, "CUSTOM");
});

test("hosted XCTest output inherits its host application's PlugIns directory", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcodeTests",
  });
  const plugins = settings.BUILT_PRODUCTS_DIR + "/HelloXcode.app/PlugIns";
  assert.equal(settings.TARGET_BUILD_DIR, plugins);
  assert.equal(settings.TARGET_BUILD_SUBPATH, "/HelloXcode.app/PlugIns");
  assert.equal(settings.DWARF_DSYM_FOLDER_PATH, plugins);
  assert.equal(settings.CODESIGNING_FOLDER_PATH, plugins + "/HelloXcodeTests.xctest");
  assert.equal(settings.PACKAGE_TYPE, "com.apple.package-type.bundle.unit-test");
  assert.equal(settings.ENABLE_TESTING_SEARCH_PATHS, "YES");
  assert.equal(settings.WRAPPER_SUFFIX, ".xctest");
  assert.equal(settings.LD_RUNPATH_SEARCH_PATHS,
    " @loader_path/Frameworks @executable_path/Frameworks");
  assert.equal(settings.INSTALL_DIR, "/tmp/HelloXcode.dst");
  assert.equal(settings.STRIP_STYLE, "non-global");
  assert.equal(settings.LIBRARY_SEARCH_PATHS,
    settings.BUILT_PRODUCTS_DIR + "   " + settings.PLATFORM_DEVELOPER_USR_DIR + "/lib");
  assert.equal(settings.SWIFT_SYSTEM_INCLUDE_PATHS,
    "  " + settings.PLATFORM_DEVELOPER_USR_DIR + "/lib");
  const frameworks = settings.PLATFORM_DEVELOPER_LIBRARY_DIR + "/Frameworks";
  assert.equal(settings.SYSTEM_FRAMEWORK_SEARCH_PATHS,
    "  " + frameworks + " " + settings.SDK_DIR + "/Developer/Library/Frameworks");
  assert.equal(settings.PRODUCT_TYPE_SWIFT_STDLIB_TOOL_FLAGS,
    "--scan-executable " + settings.PLATFORM_DEVELOPER_USR_DIR + "/lib/libXCTestSwiftSupport.dylib");
  assert.equal(settings.OTHER_SWIFT_FLAGS,
    " -plugin-path " + settings.TOOLCHAIN_DIR + "/usr/lib/swift/host/plugins/testing");
});

test("Xcode 27.1 conditional linker selectors are product scoped", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  const common = { projectPath, xcodeVersion: "27.1" };
  const app = settingsFor({ ...common, targetName: "HelloXcode" }).settings;
  const unit = settingsFor({ ...common, targetName: "HelloXcodeTests" }).settings;
  const flags = "-Xlinker -needed_framework -Xlinker XCTest -framework XCTest -Xlinker -needed-lXCTestSwiftSupport -lXCTestSwiftSupport";
  assert.equal(app.LD_RUNPATH_SEARCH_PATHS_YES, "@loader_path/../Frameworks");
  assert.equal(app.LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO, undefined);
  assert.equal(app.PRODUCT_SPECIFIC_LDFLAGS, undefined);
  assert.equal(unit.LD_RUNPATH_SEARCH_PATHS_YES, undefined);
  assert.equal(unit.LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO, "@loader_path/../Frameworks");
  assert.equal(unit.LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_YES, "@loader_path/Frameworks");
  assert.equal(unit.PRODUCT_SPECIFIC_LDFLAGS, flags);
  assert.equal(unit.PRODUCT_SPECIFIC_LDFLAGS_NO_XCTEST_NO, flags);
  assert.equal(unit.PRODUCT_TYPE_SWIFT_STDLIB_TOOL_FLAGS_NO_XCTEST_NO,
    "--scan-executable " + unit.PLATFORM_DEVELOPER_USR_DIR + "/lib/libXCTestSwiftSupport.dylib");
  const overridden = settingsFor({ ...common, targetName: "HelloXcodeTests",
    overrides: { PRODUCT_SPECIFIC_LDFLAGS: "-Wl,custom" } }).settings;
  assert.equal(overridden.PRODUCT_SPECIFIC_LDFLAGS, "-Wl,custom");
  const previous = settingsFor({ ...common, targetName: "HelloXcodeTests", xcodeVersion: "26.4" }).settings;
  assert.equal(previous.PRODUCT_SPECIFIC_LDFLAGS, undefined);
});

test("SDK stat cache directory is absent without authoritative host cache", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  for (const targetName of ["HelloXcode", "HelloXcodeTests"]) {
    const settings = settingsFor({ projectPath, targetName, xcodeVersion: "27.1" }).settings;
    assert.equal(settings.SDK_STAT_CACHE_DIR, undefined);
    const override = settingsFor({ projectPath, targetName, xcodeVersion: "27.1",
      overrides: { SDK_STAT_CACHE_DIR: "/tmp/custom-cache" } }).settings;
    assert.equal(override.SDK_STAT_CACHE_DIR, "/tmp/custom-cache");
  }
});

test("compilation CAS is absent without authoritative Xcode host cache evidence", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  const selectedRoot = "/tmp/build-cache-session-2026";
  const project = loadProject(projectPath);
  const target = project.targetByName("HelloXcode");
  const resolved = resolveBuildSettings({
    project, target, configuration: "Debug", platform: "iphonesimulator",
    derivedDataPath: selectedRoot, developerDir: "/Developer",
    arch: "arm64",
  }).settings;
  assert.equal(resolved.CACHE_ROOT, undefined);
  assert.equal(resolved.COMPILATION_CACHE_CAS_PATH, undefined);
  assert.equal(resolved.OBJROOT.startsWith(selectedRoot), true);
  const overridden = resolveBuildSettings({
    project, target, configuration: "Debug", platform: "iphonesimulator",
    derivedDataPath: selectedRoot, developerDir: "/Developer",
    arch: "arm64",
    overrides: { COMPILATION_CACHE_CAS_PATH: "/tmp/custom-cas" },
  }).settings;
  assert.equal(overridden.COMPILATION_CACHE_CAS_PATH, "/tmp/custom-cas");
});

test("Xcode 27.1 simulator signing conditionals belong to app, not XCTest", () => {
  const projectPath = fixture("HelloXcode/HelloXcode.xcodeproj");
  const base = {
    projectPath, xcodeVersion: "27.1",
    sdk: { path: "/SDK/iphonesimulator27.1.sdk",
      name: "iphonesimulator27.1", version: "27.1",
      root: "iphonesimulator", defaultProperties: {} },
  };
  const app = settingsFor({ ...base, targetName: "HelloXcode" }).settings;
  assert.equal(app.ENTITLEMENTS_ALLOWED, "NO");
  assert.equal(app.PROVISIONING_PROFILE_REQUIRED_YES_YES, "YES");
  assert.equal(app.AGGREGATE_TRACKED_DOMAINS, "YES");
  const tests = settingsFor({ ...base, targetName: "HelloXcodeTests" }).settings;
  assert.equal(tests.ENTITLEMENTS_ALLOWED, undefined);
  assert.equal(tests.PROVISIONING_PROFILE_REQUIRED_YES_YES, undefined);
  assert.equal(tests.AGGREGATE_TRACKED_DOMAINS, undefined);
  const overridden = settingsFor({ ...base, targetName: "HelloXcode",
    overrides: {
      ENTITLEMENTS_ALLOWED: "CUSTOM",
      PROVISIONING_PROFILE_REQUIRED_YES_YES: "CUSTOM",
      AGGREGATE_TRACKED_DOMAINS: "CUSTOM",
    },
  }).settings;
  assert.equal(overridden.ENTITLEMENTS_ALLOWED, "CUSTOM");
  assert.equal(overridden.PROVISIONING_PROFILE_REQUIRED_YES_YES, "CUSTOM");
  assert.equal(overridden.AGGREGATE_TRACKED_DOMAINS, "CUSTOM");
  const older = settingsFor({ ...base, targetName: "HelloXcode",
    xcodeVersion: "26.4" }).settings;
  assert.equal(older.ENTITLEMENTS_ALLOWED, undefined);
  assert.equal(older.PROVISIONING_PROFILE_REQUIRED_YES_YES, undefined);
  assert.equal(older.AGGREGATE_TRACKED_DOMAINS, undefined);
});

test("XCTest defaults remain subordinate to explicit build-setting overrides", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcodeTests");
  const { settings } = resolveBuildSettings({
    project, target,
    configuration: "Debug", platform: "iphonesimulator",
    sdk: {
      path: "/SDK/iPhoneSimulator27.1.sdk", root: "iphonesimulator",
      name: "iphonesimulator27.1", version: "27.1", defaultProperties: {},
    },
    arch: "arm64", hostArch: "arm64",
    developerDir: "/Developer", derivedDataPath: "/tmp/xcl-test-overrides",
    overrides: {
      OTHER_SWIFT_FLAGS: "-DUSER_CUSTOM",
      LIBRARY_SEARCH_PATHS: "/Custom/Libraries",
      STRIP_STYLE: "all",
      EFFECTIVE_SWIFT_VERSION: "custom-version",
    },
  });
  assert.equal(settings.OTHER_SWIFT_FLAGS, "-DUSER_CUSTOM");
  assert.equal(settings.LIBRARY_SEARCH_PATHS, "/Custom/Libraries");
  assert.equal(settings.STRIP_STYLE, "all");
  assert.equal(settings.EFFECTIVE_SWIFT_VERSION, "custom-version");
});

test("context-derived settings cannot be erased by unscoped Xcode spec defaults", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const { settings, layers } = resolveBuildSettings({
    project,
    target,
    configuration: "Debug",
    platform: "iphonesimulator",
    sdk: { name: "iphonesimulator27.1", version: "27.1", path: "/SDK/iPhoneSimulator.sdk", root: "iphonesimulator", defaultProperties: {} },
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: "/tmp/xcl-context-DD",
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    action: "build",
    specDefaults: {
      ACTION: "", CONFIGURATION: "", ARCHS: "", BUILT_PRODUCTS_DIR: "build",
      CONTENTS_FOLDER_PATH: "", CODE_SIGNING_ALLOWED: "NO", CODE_SIGN_IDENTITY: "",
      ARCHS_STANDARD: "arm64 x86_64", DEAD_CODE_STRIPPING: "YES",
      NEW_XCODE_OPTION: "spec-supported",
    },
  });
  assert.equal(settings.ACTION, "build");
  assert.equal(settings.CONFIGURATION, "Debug");
  // Xcode reports the requested multi-architecture set even though the
  // build planner compiles only the effective active architecture.
  assert.equal(settings.ARCHS, "arm64 x86_64");
  assert.equal(settings.CODE_SIGNING_ALLOWED, "YES");
  assert.equal(settings.CODE_SIGN_IDENTITY, "-");
  assert.equal(settings.CONTENTS_FOLDER_PATH, "HelloXcode.app");
  assert.equal(settings.BUILT_PRODUCTS_DIR, "/tmp/xcl-context-DD/Build/Products/Debug-iphonesimulator");
  assert.equal(settings.ARCHS_STANDARD, "arm64 x86_64");
  assert.equal(settings.DEAD_CODE_STRIPPING, "YES");
  assert.equal(settings.NEW_XCODE_OPTION, "spec-supported");
  assert.ok(layers.findIndex((layer) => layer.name === "xcode-spec-defaults") <
    layers.findIndex((layer) => layer.name === "defaults"));
});

test("ONLY_ACTIVE_ARCH affects effective compile arch without reducing ARCHS in settings output", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const { settings } = resolveBuildSettings({
    project,
    target,
    configuration: "Debug",
    platform: "iphonesimulator",
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: "/tmp/xcl-DD",
    developerDir: "/Developer",
    specDefaults: { ARCHS_STANDARD: "arm64 x86_64" },
  });
  assert.equal(settings.ONLY_ACTIVE_ARCH, "YES");
  assert.equal(settings.ARCHS, "arm64 x86_64");
  const overridden = resolveBuildSettings({
    project,
    target,
    configuration: "Debug",
    platform: "iphonesimulator",
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: "/tmp/xcl-DD",
    developerDir: "/Developer",
    specDefaults: { ARCHS_STANDARD: "arm64 x86_64" },
    overrides: { ARCHS: "arm64" },
  });
  assert.equal(overridden.settings.ARCHS, "arm64");
  assert.equal(overridden.settings.ONLY_ARCH, "arm64");
});

test("missing-reference defaults remain subordinate to explicit user settings", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcode",
    overrides: {
      RPATH_ORIGIN: "@executable_path",
      ONLY_ARCH: "custom_architecture",
      SKIP_COPYING_TEST_FRAMEWORKS: "NO",
      PLATFORM_USES_DSYMS: "NO",
      RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET: "19.0",
    },
  });
  assert.equal(settings.RPATH_ORIGIN, "@executable_path");
  assert.equal(settings.ONLY_ARCH, "custom_architecture");
  assert.equal(settings.SKIP_COPYING_TEST_FRAMEWORKS, "NO");
  assert.equal(settings.PLATFORM_USES_DSYMS, "NO");
  assert.equal(settings.RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET, "19.0");
});

test("explicit user settings still supersede restored contextual defaults", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const { settings } = resolveBuildSettings({
    project, target, configuration: "Debug", platform: "iphonesimulator",
    sdk: null, arch: "arm64", hostArch: "arm64",
    derivedDataPath: "/tmp/xcl-override-DD",
    developerDir: "/Developer",
    specDefaults: { CODE_SIGNING_ALLOWED: "NO", CONFIGURATION: "" },
    overrides: { CODE_SIGNING_ALLOWED: "NO", CUSTOM_XCODE_SETTING: "override" },
  });
  assert.equal(settings.CODE_SIGNING_ALLOWED, "NO");
  assert.equal(settings.CONFIGURATION, "Debug");
  assert.equal(settings.CUSTOM_XCODE_SETTING, "override");
});

test("installed SDK and Xcode paths remain authoritative over spec placeholders", () => {
  const project = loadProject(fixture("HelloXcode/HelloXcode.xcodeproj"));
  const target = project.targetByName("HelloXcode");
  const developerDir = "/Applications/Xcode.app/Contents/Developer";
  const sdkPath = developerDir + "/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator27.1.sdk";
  const { settings } = resolveBuildSettings({
    project, target,
    configuration: "Debug", platform: "iphonesimulator",
    arch: "arm64", hostArch: "arm64",
    derivedDataPath: "/tmp/xcl-location-parity",
    developerDir,
    sdk: {
      name: "iphonesimulator27.1", version: "27.1", path: sdkPath,
      root: "iphonesimulator", defaultProperties: {},
    },
    // -sdk is a command-line selection and overrides the project's SDKROOT.
    overrides: { SDKROOT: sdkPath },
    specDefaults: {
      SDKROOT: "", SDK_NAME: "", SDK_DIR: "",
      DEVELOPER_BIN_DIR: "", PLATFORM_DEVELOPER_SDK_DIR: "",
      ARCHS_STANDARD: "arm64", CODE_SIGNING_ALLOWED: "NO",
      GCC_VERSION: "xcl-spec-only",
    },
  });
  assert.equal(settings.SDKROOT, sdkPath);
  assert.equal(settings.SDK_NAME, "iphonesimulator27.1");
  assert.equal(settings.SDK_DIR, sdkPath);
  assert.equal(settings.DEVELOPER_BIN_DIR, developerDir + "/usr/bin");
  assert.equal(settings.PLATFORM_DEVELOPER_SDK_DIR,
    developerDir + "/Platforms/iPhoneSimulator.platform/Developer/SDKs");
  assert.equal(settings.ARCHS, "arm64 x86_64");
  assert.equal(settings.CODE_SIGNING_ALLOWED, "YES");
  assert.equal(settings.GCC_VERSION, "com.apple.compilers.llvm.clang.1_0");
});

test("HelloXcode Release settings", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcode",
    configuration: "Release",
  });
  assert.equal(settings.SWIFT_OPTIMIZATION_LEVEL, "-O");
  assert.equal(settings.SWIFT_COMPILATION_MODE, "wholemodule");
  assert.equal(settings.DEBUG_INFORMATION_FORMAT, "dwarf-with-dsym");
  assert.equal(settings.VALIDATE_PRODUCT, "YES");
  assert.equal(settings.ONLY_ACTIVE_ARCH, "NO");
  assert.equal(settings.ENABLE_TESTABILITY, "NO");
});

test("macOS app uses a Contents bundle layout", () => {
  const { settings } = settingsFor({
    projectPath: fixture("HelloXcode/HelloXcode.xcodeproj"),
    targetName: "HelloXcode",
    platform: "macosx",
  });
  assert.equal(settings.EXECUTABLE_PATH, "HelloXcode.app/Contents/MacOS/HelloXcode");
  assert.equal(settings.INFOPLIST_PATH, "HelloXcode.app/Contents/Info.plist");
  assert.equal(settings.UNLOCALIZED_RESOURCES_FOLDER_PATH, "HelloXcode.app/Contents/Resources");
  assert.equal(settings.FRAMEWORKS_FOLDER_PATH, "HelloXcode.app/Contents/Frameworks");
  assert.equal(settings.PUBLIC_HEADERS_FOLDER_PATH, "HelloXcode.app/Contents/Headers");
  assert.equal(settings.PRIVATE_HEADERS_FOLDER_PATH, "HelloXcode.app/Contents/PrivateHeaders");
  assert.equal(settings.SHALLOW_BUNDLE, "NO");
});

test("xcconfig include chains and precedence", () => {
  const { settings, warnings } = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
  });
  assert.deepEqual(warnings, []);
  assert.equal(settings.PROJECT_LEVEL_MARKER, "project-xcconfig");
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "com.example.ConfigChains");
  assert.equal(settings.GCC_PREPROCESSOR_DEFINITIONS, " SHARED=1");
  assert.equal(settings.OTHER_LDFLAGS, " -ObjC -lsim -framework Security");
  assert.equal(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS, "DEBUG ");
});

test("SDK-conditional xcconfig values differ by platform", () => {
  const simulator = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
  }).settings;
  const device = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
    platform: "iphoneos",
  }).settings;
  assert.equal(simulator.OTHER_LDFLAGS, " -ObjC -lsim -framework Security");
  assert.equal(device.OTHER_LDFLAGS, " -ObjC -framework CoreLocation -framework Security");
});

test("Release configuration uses its own xcconfig", () => {
  const { settings } = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
    configuration: "Release",
  });
  assert.equal(settings.OTHER_LDFLAGS, " -lrelease");
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "com.example.projectbase");
  assert.equal(settings.PROJECT_LEVEL_MARKER, undefined);
});

test("expandSettings supports modifiers and cycle protection", () => {
  const { settings, missing } = expandSettings({
    A: "Hello World",
    B: "$(A:lower)",
    C: "$(A:upper)",
    D: "$(A:rfc1034identifier)",
    E: "$(A:file)",
    F: "$(A:c99extidentifier)",
    G: "$(MISSING:default=fallback)",
    H: "$(LOOP_A)",
    LOOP_A: "$(LOOP_B)",
    LOOP_B: "$(LOOP_A)",
  });
  assert.equal(settings.B, "hello world");
  assert.equal(settings.C, "HELLO WORLD");
  assert.equal(settings.D, "Hello-World");
  assert.equal(settings.E, "Hello World");
  assert.equal(settings.F, "Hello_World");
  assert.equal(settings.G, "fallback");
  assert.equal(settings.H, "");
  assert.ok(missing.has("MISSING"));
});

test("condition matching understands wildcards and names", () => {
  const context = {
    configuration: "Debug",
    platform: "iphonesimulator",
    sdkName: "iphonesimulator18.0",
    sdkRoot: "iphonesimulator",
    arch: "arm64",
  };
  assert.equal(matchConditions([{ name: "sdk", value: "iphonesimulator*" }], context), true);
  assert.equal(matchConditions([{ name: "sdk", value: "iphoneos*" }], context), false);
  assert.equal(matchConditions([{ name: "arch", value: "arm64" }], context), true);
  assert.equal(matchConditions([{ name: "config", value: "Debug" }], context), true);
  assert.equal(matchConditions([{ name: "config", value: "Release" }], context), false);
});

test("product types set wrapper and Mach-O defaults", () => {
  const framework = productTypeInfo("com.apple.product-type.framework");
  assert.equal(framework.wrapperExtension, "framework");
  assert.equal(framework.machOType, "mh_dylib");
  const tests = productTypeInfo("com.apple.product-type.bundle.unit-test");
  assert.equal(tests.wrapperExtension, "xctest");
  const staticLibrary = productTypeInfo("com.apple.product-type.library.static");
  assert.equal(staticLibrary.executablePrefix, "lib");
});

test("default DerivedData path is deterministic and project-specific", () => {
  const a = defaultDerivedDataPath("/Projects/Alpha/Alpha.xcodeproj");
  const b = defaultDerivedDataPath("/Projects/Alpha/Alpha.xcodeproj");
  const c = defaultDerivedDataPath("/Projects/Beta/Beta.xcodeproj");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /Library[\\/]Developer[\\/]Xcode[\\/]DerivedData[\\/]Alpha-[a-z0-9]+$/);
});

test("generic defaults expose a broad settings table", () => {
  const defaults = genericDefaults({
    project: { name: "Sample", path: "/Projects/Sample.xcodeproj" },
    projectPath: "/Projects/Sample.xcodeproj",
    target: {
      name: "Sample",
      productType: "com.apple.product-type.application",
      productName: "Sample",
    },
    configuration: "Debug",
    platform: "iphonesimulator",
    sdk: null,
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: "/tmp/DD",
    developerDir: "/Developer",
    action: "build",
  });
  assert.equal(defaults.MACH_O_TYPE, "mh_execute");
  assert.equal(defaults.WRAPPER_EXTENSION, "app");
  assert.ok(Object.keys(defaults).length > 80);
});

test("showBuildSettings preserves whitespace produced by inherited values", () => {
  const { settings } = expandSettings({
    PREPROCESSOR_FLAGS: "DEBUG=1 ",
    SWIFT_CONDITIONS: "DEBUG ",
    LEADING_SEARCH_PATH: " /Developer/Frameworks",
    SPACED_EMPTY: " ",
    INTERNAL_SPACE: "foo    bar",
  });
  assert.equal(settings.PREPROCESSOR_FLAGS, "DEBUG=1 ");
  assert.equal(settings.SWIFT_CONDITIONS, "DEBUG ");
  assert.equal(settings.LEADING_SEARCH_PATH, " /Developer/Frameworks");
  assert.equal(settings.SPACED_EMPTY, " ");
  assert.equal(settings.INTERNAL_SPACE, "foo bar");
});

test("nested references expand inside a setting name", () => {
  const { settings } = expandSettings({
    XCODE_VERSION_MAJOR: "1600",
    MACOSX_DEPLOYMENT_TARGET: "$(MACOSX_DEPLOYMENT_TARGET_XCODE_$(XCODE_VERSION_MAJOR))",
    MACOSX_DEPLOYMENT_TARGET_XCODE_1600: "12.0",
  });
  assert.equal(settings.MACOSX_DEPLOYMENT_TARGET, "12.0");
});

test("macOS frameworks keep a flat wrapper while apps use Contents", () => {
  const base = {
    project: { name: "Sample", path: "/Projects/Sample.xcodeproj" },
    projectPath: "/Projects/Sample.xcodeproj",
    configuration: "Release",
    platform: "macosx",
    sdk: null,
    arch: "arm64",
    hostArch: "arm64",
    derivedDataPath: "/tmp/DD",
    developerDir: "/Developer",
    action: "build",
  };
  const framework = genericDefaults({
    ...base,
    target: {
      name: "SampleKit",
      productType: "com.apple.product-type.framework",
      productName: "SampleKit",
    },
  });
  assert.equal(framework.UNLOCALIZED_RESOURCES_FOLDER_PATH, "$(WRAPPER_NAME)");
  assert.equal(framework.EXECUTABLE_PATH, "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)");
  assert.equal(framework.INFOPLIST_PATH, "$(WRAPPER_NAME)/Info.plist");

  const app = genericDefaults({
    ...base,
    target: {
      name: "Sample",
      productType: "com.apple.product-type.application",
      productName: "Sample",
    },
  });
  assert.equal(app.UNLOCALIZED_RESOURCES_FOLDER_PATH, "$(WRAPPER_NAME)/Contents/Resources");
  assert.equal(app.EXECUTABLE_PATH, "$(WRAPPER_NAME)/Contents/MacOS/$(EXECUTABLE_NAME)");
});

test("spec files contribute defaults only where a DefaultValue exists", () => {
  const raw = `[
    {
      Type = ProductType;
      Identifier = "com.apple.product-type.framework";
      BasedOn = "com.apple.product-type";
      Class = "XCProductTypeSpecification";
    },
    {
      Type = Compiler;
      Identifier = "com.apple.compilers.example";
      Options = (
        { Name = "EXAMPLE_OPTION"; Type = Boolean; DefaultValue = YES; },
        { Name = "EMPTY_OPTION"; Type = String; DefaultValue = ""; }
      );
    }
  ]`;
  const parsed = parsePlist(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].Options[0].DefaultValue, "YES");
  assert.equal(parsed[1].Options[1].DefaultValue, "");
});
