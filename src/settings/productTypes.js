/**
 * Mapping from Xcode product-type identifiers to the settings Xcode applies.
 * Values mirror the product-type specifications shipped with Xcode.
 */
export const PRODUCT_TYPES = Object.freeze({
  "com.apple.product-type.application": {
    kind: "application",
    wrapperExtension: "app",
    machOType: "mh_execute",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "NO",
    runpath: "@executable_path/Frameworks",
    extra: {
      GENERATE_INFOPLIST_FILE: "NO",
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: "AccentColor",
      // Default app product settings; an explicit target choice still wins.
      ENABLE_ON_DEMAND_RESOURCES: "YES",
      GENERATE_PKGINFO_FILE: "YES",
      SUPPORTS_MACCATALYST: "NO",
    },
  },
  "com.apple.product-type.application.watchapp2": {
    kind: "watch-application",
    wrapperExtension: "app",
    machOType: "mh_execute",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "NO",
    runpath: "@executable_path/Frameworks",
    extra: {},
  },
  "com.apple.product-type.framework": {
    kind: "framework",
    wrapperExtension: "framework",
    machOType: "mh_dylib",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "@executable_path/Frameworks @loader_path/Frameworks",
    extra: {
      DEFINES_MODULE: "YES",
      DYLIB_INSTALL_NAME_BASE: "@rpath",
      LD_DYLIB_INSTALL_NAME: "@rpath/$(EXECUTABLE_PATH)",
      VERSIONING_SYSTEM: "apple-generic",
      CURRENT_PROJECT_VERSION: "1",
      DYLIB_COMPATIBILITY_VERSION: "1",
      DYLIB_CURRENT_VERSION: "1",
      MODULEMAP_FILE: "",
    },
  },
  "com.apple.product-type.framework.static": {
    kind: "static-framework",
    wrapperExtension: "framework",
    machOType: "staticlib",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "",
    extra: {
      DEFINES_MODULE: "YES",
      MACH_O_TYPE: "staticlib",
    },
  },
  "com.apple.product-type.library.static": {
    kind: "static-library",
    wrapperExtension: "a",
    executablePrefix: "lib",
    machOType: "staticlib",
    executablePath: "$(EXECUTABLE_NAME)",
    infoplistPath: "",
    skipInstall: "YES",
    runpath: "",
    extra: { EXECUTABLE_PREFIX: "lib" },
  },
  "com.apple.product-type.library.dynamic": {
    kind: "dynamic-library",
    wrapperExtension: "dylib",
    executablePrefix: "lib",
    machOType: "mh_dylib",
    executablePath: "$(EXECUTABLE_NAME)",
    infoplistPath: "",
    skipInstall: "YES",
    runpath: "@executable_path/Frameworks @loader_path/Frameworks",
    extra: {
      EXECUTABLE_PREFIX: "lib",
      DYLIB_INSTALL_NAME_BASE: "@rpath",
      LD_DYLIB_INSTALL_NAME: "@rpath/$(EXECUTABLE_PATH)",
    },
  },
  "com.apple.product-type.bundle.unit-test": {
    kind: "unit-test",
    wrapperExtension: "xctest",
    machOType: "mh_bundle",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "@executable_path/Frameworks @loader_path/Frameworks",
    extra: {
      BUNDLE_LOADER: "$(TEST_HOST)",
      TEST_HOST: "",
      WRAPPER_EXTENSION: "xctest",
      ENABLE_TESTING_SEARCH_PATHS: "YES",
    },
  },
  "com.apple.product-type.bundle.ui-testing": {
    kind: "ui-test",
    wrapperExtension: "xctest",
    machOType: "mh_bundle",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "@executable_path/Frameworks @loader_path/Frameworks",
    extra: {
      TEST_TARGET_NAME: "",
      WRAPPER_EXTENSION: "xctest",
    },
  },
  "com.apple.product-type.app-extension": {
    kind: "app-extension",
    wrapperExtension: "appex",
    machOType: "mh_bundle",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "@executable_path/Frameworks @executable_path/../../Frameworks",
    extra: { APPLICATION_EXTENSION_API_ONLY: "YES", SKIP_INSTALL: "YES" },
  },
  "com.apple.product-type.bundle": {
    kind: "bundle",
    wrapperExtension: "bundle",
    machOType: "mh_bundle",
    executablePath: "$(WRAPPER_NAME)/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Info.plist",
    skipInstall: "YES",
    runpath: "@loader_path/Frameworks",
    extra: {},
  },
  "com.apple.product-type.tool": {
    kind: "tool",
    wrapperExtension: "",
    machOType: "mh_execute",
    executablePath: "$(EXECUTABLE_NAME)",
    infoplistPath: "",
    skipInstall: "NO",
    runpath: "@executable_path/../Frameworks",
    extra: {},
  },
  "com.apple.product-type.xpc-service": {
    kind: "xpc-service",
    wrapperExtension: "xpc",
    machOType: "mh_execute",
    executablePath: "$(WRAPPER_NAME)/Contents/MacOS/$(EXECUTABLE_NAME)",
    infoplistPath: "$(WRAPPER_NAME)/Contents/Info.plist",
    skipInstall: "YES",
    runpath: "@executable_path/../Frameworks",
    extra: { MACOSX_DEPLOYMENT_TARGET: "10.15" },
  },
  "com.apple.product-type.bundle.metal": {
    kind: "metal-library",
    wrapperExtension: "metallib",
    machOType: "mh_dylib",
    executablePath: "$(WRAPPER_NAME)",
    infoplistPath: "",
    skipInstall: "YES",
    runpath: "",
    extra: { MTL_LANGUAGE_REVISION: "Metal20" },
  },
});

function packageTypeFor(info) {
  switch (info.wrapperExtension) {
    case "framework":
      return "FMWK";
    case "xctest":
    case "bundle":
    case "appex":
      return "BNDL";
    case "xpc":
      return "XPC!";
    case "dylib":
      return "DYLIB";
    case "a":
      return "????";
    case "":
      return "????";
    default:
      return "APPL";
  }
}

export function productTypeInfo(productType) {
  const info = PRODUCT_TYPES[productType] ?? {
    kind: "unknown",
    wrapperExtension: "",
    machOType: "mh_execute",
    executablePath: "$(EXECUTABLE_NAME)",
    infoplistPath: "",
    skipInstall: "NO",
    runpath: "",
    extra: {},
  };
  return { ...info, packageType: packageTypeFor(info) };
}

export function productTypeLabel(productType) {
  return productTypeInfo(productType).kind;
}
