import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadProject } from "../src/xcode/pbxproj.js";
import { expandSettings, matchConditions, resolveBuildSettings } from "../src/settings/resolver.js";
import { genericDefaults, defaultDerivedDataPath } from "../src/settings/defaults.js";
import { productTypeInfo } from "../src/settings/productTypes.js";
import { parsePlist } from "../src/plist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

function settingsFor({ projectPath, targetName, configuration = "Debug", platform = "iphonesimulator", arch = "arm64", overrides = {}, sdk }) {
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
    overrides: { SDKROOT: platform, ...overrides },
  });
}

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
  assert.equal(settings.DERIVED_SOURCES_DIR, settings.DERIVED_FILE_DIR);
  assert.ok(settings.OBJECT_FILE_DIR_normal.endsWith("/HelloXcode.build/Objects-normal"));
  assert.ok(settings.FIXED_FILES_DIR.endsWith("/HelloXcode.build/FixedFiles"));
  assert.equal(settings.DWARF_DSYM_FOLDER_PATH, settings.BUILT_PRODUCTS_DIR);
  assert.equal(settings.EXECUTABLE_FOLDER_PATH, "HelloXcode.app");
  assert.equal(settings.LOCALIZED_RESOURCES_FOLDER_PATH, "HelloXcode.app/en.lproj");
  assert.equal(settings.DEVELOPMENT_LANGUAGE, "en");
  assert.equal(settings.ARCHS, "arm64 x86_64");
  assert.equal(settings.ONLY_ACTIVE_ARCH, "YES");
  assert.equal(settings.SWIFT_OPTIMIZATION_LEVEL, "-Onone");
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
  assert.equal(settings.GCC_PREPROCESSOR_DEFINITIONS, "DEBUG=1");
  assert.equal(settings.EFFECTIVE_PLATFORM_NAME, "-iphonesimulator");
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
  assert.equal(settings.GCC_VERSION, "xcl-spec-only");
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
});

test("xcconfig include chains and precedence", () => {
  const { settings, warnings } = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
  });
  assert.deepEqual(warnings, []);
  assert.equal(settings.PROJECT_LEVEL_MARKER, "project-xcconfig");
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "com.example.ConfigChains");
  assert.equal(settings.GCC_PREPROCESSOR_DEFINITIONS, "SHARED=1");
  assert.equal(settings.OTHER_LDFLAGS, "-ObjC -lsim -framework Security");
  assert.equal(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS, "DEBUG");
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
  assert.equal(simulator.OTHER_LDFLAGS, "-ObjC -lsim -framework Security");
  assert.equal(device.OTHER_LDFLAGS, "-ObjC -framework CoreLocation -framework Security");
});

test("Release configuration uses its own xcconfig", () => {
  const { settings } = settingsFor({
    projectPath: fixture("ConfigChains/ConfigChains.xcodeproj"),
    targetName: "ConfigChains",
    configuration: "Release",
  });
  assert.equal(settings.OTHER_LDFLAGS, "-lrelease");
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
