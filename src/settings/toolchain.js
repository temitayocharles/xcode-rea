import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readPlistFile } from "../plist/index.js";

const PLATFORM_DIRS = {
  iphoneos: "iPhoneOS.platform",
  iphonesimulator: "iPhoneSimulator.platform",
  macosx: "MacOSX.platform",
  appletvos: "AppleTVOS.platform",
  appletvsimulator: "AppleTVSimulator.platform",
  watchos: "WatchOS.platform",
  watchsimulator: "WatchSimulator.platform",
  xros: "XROS.platform",
  xrsimulator: "XRSimulator.platform",
};

const CANDIDATE_DEVELOPER_DIRS = [
  "/Applications/Xcode.app/Contents/Developer",
  "/Applications/Xcode-beta.app/Contents/Developer",
  "/Library/Developer/CommandLineTools",
];

function readVersion(developerDir) {
  const xcodeContents = join(developerDir, "..");
  const candidates = [
    join(xcodeContents, "version.plist"),
    join(xcodeContents, "..", "version.plist"),
  ];
  for (const candidate of candidates) {
    try {
      const info = readPlistFile(candidate);
      return {
        version: info.CFBundleShortVersionString ?? null,
        build: info.ProductBuildVersion ?? null,
      };
    } catch {
      // Not an Xcode bundle (for example Command Line Tools).
    }
  }
  try {
    const text = readFileSync(join(developerDir, "..", "..", "version.plist"));
    if (text) return { version: null, build: null };
  } catch {
    // ignore
  }
  return { version: null, build: null };
}

/**
 * Find the active developer directory the same way `xcode-select` and
 * `xcodebuild` do: DEVELOPER_DIR, then `xcode-select -p`, then well-known paths.
 */
export function detectToolchain(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = [];

  if (env.DEVELOPER_DIR) candidates.push(env.DEVELOPER_DIR);
  if (platform === "darwin") {
    try {
      const selected = execFileSync("xcode-select", ["-p"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      if (selected) candidates.push(selected);
    } catch {
      // xcode-select is absent on Linux or misconfigured.
    }
  }
  candidates.push(...CANDIDATE_DEVELOPER_DIRS);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!existsSync(join(candidate, "usr", "bin")) && !existsSync(candidate)) continue;
    const isCommandLineTools = /CommandLineTools/i.test(candidate);
    const { version, build } = readVersion(candidate);
    return {
      found: true,
      developerDir: candidate,
      xcodeApp: isCommandLineTools ? null : join(candidate, ".."),
      isCommandLineTools,
      version,
      build,
      platforms: listPlatforms(candidate),
    };
  }

  return {
    found: false,
    developerDir: env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
    xcodeApp: null,
    isCommandLineTools: false,
    version: null,
    build: null,
    platforms: [],
  };
}

export function listPlatforms(developerDir) {
  const root = join(developerDir, "Platforms");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".platform"))
    .map((name) => ({
      directory: join(root, name),
      name: name.replace(/\.platform$/, ""),
      identifier: platformIdentifier(name),
    }));
}

function platformIdentifier(directoryName) {
  switch (directoryName) {
    case "iPhoneOS.platform":
      return "iphoneos";
    case "iPhoneSimulator.platform":
      return "iphonesimulator";
    case "MacOSX.platform":
      return "macosx";
    case "AppleTVOS.platform":
      return "appletvos";
    case "AppleTVSimulator.platform":
      return "appletvsimulator";
    case "WatchOS.platform":
      return "watchos";
    case "WatchSimulator.platform":
      return "watchsimulator";
    case "XROS.platform":
      return "xros";
    case "XRSimulator.platform":
      return "xrsimulator";
    default:
      return directoryName.replace(/\.platform$/, "").toLowerCase();
  }
}

function sdkSearchRoots(developerDir, platform) {
  const roots = [];
  if (platform === "macosx") {
    roots.push(join(developerDir, "SDKs"));
  }
  const platformDir = PLATFORM_DIRS[platform];
  if (platformDir) {
    roots.push(join(developerDir, "Platforms", platformDir, "Developer", "SDKs"));
  }
  return roots;
}

function versionParts(value) {
  return String(value)
    .split(/[._-]/)
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readSdkSettings(path) {
  try {
    return readPlistFile(join(path, "SDKSettings.plist"));
  } catch {
    return null;
  }
}

/** SDK system image build number, when supplied by Apple's SDK installation. */
export function sdkBuildVersion(sdkPath, settings = readSdkSettings(sdkPath)) {
  if (typeof settings?.ProductBuildVersion === "string" && settings.ProductBuildVersion) {
    return settings.ProductBuildVersion;
  }
  try {
    const system = readPlistFile(join(sdkPath, "System", "Library", "CoreServices", "SystemVersion.plist"));
    return typeof system.ProductBuildVersion === "string" ? system.ProductBuildVersion : null;
  } catch {
    return null;
  }
}

/**
 * Xcode can install both an unversioned .sdk directory and a versioned sibling.
 * The unversioned directory is not necessarily a symlink. Prefer a versioned
 * sibling only when its own SDKSettings identify the same SDK/version.
 */
export function canonicalSdkPath(path, settings = readSdkSettings(path)) {
  const resolved = realpathSync(path);
  if (!settings?.Version) return resolved;
  const name = basename(resolved, ".sdk");
  const version = String(settings.Version);
  if (name.endsWith(version)) return resolved;
  const candidate = join(dirname(resolved), `${name}${version}.sdk`);
  if (!existsSync(candidate)) return resolved;
  const sibling = readSdkSettings(candidate);
  if (
    sibling?.Version === settings.Version &&
    sibling?.CanonicalName === settings.CanonicalName
  ) return realpathSync(candidate);
  return resolved;
}

/** CanonicalName can already include the version, e.g. iphonesimulator27.1. */
export function sdkDisplayName(canonicalName, version) {
  const canonical = String(canonicalName ?? "");
  const v = String(version ?? "");
  return !v || canonical.endsWith(v) ? canonical : `${canonical}${v}`;
}

/**
 * Ask Apple's installed xcrun which SDK directory it selects. Unlike
 * realpathSync, xcrun preserves the SDK directory spelling used by the active
 * Apple toolchain; both may exist as valid physical or symlinked .sdk paths.
 * This must not override an explicitly requested absolute SDK directory.
 */
export function xcrunSelectedSdkPath(sdkName, {
  hostPlatform = process.platform,
  run = execFileSync,
} = {}) {
  if (hostPlatform !== "darwin" || !sdkName || /[\\/]/.test(sdkName)) return null;
  try {
    const path = String(run("xcrun", ["--sdk", sdkName, "--show-sdk-path"], {
      encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    return path.endsWith(".sdk") && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an SDK for a platform. `requested` may be a name (iphonesimulator),
 * a versioned name (iphonesimulator18.0), or an absolute path to an .sdk.
 */
export function resolveSdk({ developerDir, platform, requested = null, sdkVersion = null, hostPlatform = process.platform, runXcrun = execFileSync }) {
  if (requested && requested.endsWith(".sdk") && existsSync(requested)) {
    const actualPath = realpathSync(requested);
    const settings = readSdkSettings(actualPath);
    const sdkPath = canonicalSdkPath(actualPath, settings);
    const canonical = settings?.CanonicalName ?? basename(requested, ".sdk");
    return {
      path: sdkPath,
      root: canonical,
      name: sdkDisplayName(canonical, settings?.Version),
      version: settings?.Version ?? null,
      canonicalName: canonical,
      defaultProperties: settings?.DefaultProperties ?? {},
      productBuildVersion: sdkBuildVersion(sdkPath, settings),
      settings,
    };
  }

  // The installed Xcode/CLT selection is the authority for active symbolic
  // SDK names. Use this spelling for build settings, but keep filesystem
  // enumeration as a fallback for Linux, offline fixtures and unsupported SDKs.
  // A requested OS version without an explicit SDK should still be resolved by
  // normal version matching below.
  if (!sdkVersion || requested) {
    const selected = xcrunSelectedSdkPath(requested || platform, {
      hostPlatform, run: runXcrun,
    });
    if (selected) {
      const settings = readSdkSettings(selected);
      const name = settings?.CanonicalName ?? basename(selected, ".sdk");
      const version = settings?.Version ?? null;
      // Validate that the returned SDK is for the requested platform. If it
      // points elsewhere, fall back to local SDK metadata discovery.
      if (!requested || requested === name || name.startsWith(platform)) {
        return {
          path: selected,
          root: name,
          name: sdkDisplayName(name, version),
          version,
          canonicalName: name,
          defaultProperties: settings?.DefaultProperties ?? {},
          productBuildVersion: sdkBuildVersion(selected, settings),
          settings,
        };
      }
    }
  }

  const roots = sdkSearchRoots(developerDir, platform);
  const entries = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".sdk")) continue;
      const discoveredPath = join(root, name);
      if (!statSync(discoveredPath).isDirectory()) continue;
      // A versionless iPhoneSimulator.sdk is commonly a symlink to the
      // concrete versioned SDK. Xcode reports the canonical SDK directory.
      const resolvedPath = realpathSync(discoveredPath);
      const settings = readSdkSettings(resolvedPath);
      const path = canonicalSdkPath(resolvedPath, settings);
      const canonical = settings?.CanonicalName ?? name.replace(/\.sdk$/, "");
      const version = settings?.Version ?? name.replace(/\.sdk$/, "").replace(canonical, "");
      entries.push({
        path,
        root: canonical,
        canonicalName: canonical,
        version,
        name: sdkDisplayName(canonical, version),
        defaultProperties: settings?.DefaultProperties ?? {},
        productBuildVersion: sdkBuildVersion(path, settings),
        settings,
      });
    }
  }

  if (entries.length === 0) {
    return {
      path: null,
      root: requested ?? platform,
      name: requested ?? platform,
      version: null,
      canonicalName: requested ?? platform,
      defaultProperties: {},
      productBuildVersion: null,
      settings: null,
      missing: true,
    };
  }

  const requestedRoot = requested?.replace(/\d+(\.\d+)*$/, "") ?? platform;
  const filtered = entries.filter(
    (entry) => entry.canonicalName === requested || entry.root === requestedRoot,
  );
  const pool = filtered.length > 0 ? filtered : entries;
  pool.sort((a, b) => compareVersions(b.version ?? "0", a.version ?? "0"));

  if (sdkVersion) {
    const exact = pool.find((entry) => String(entry.version) === String(sdkVersion));
    if (exact) return exact;
  }
  return pool[0];
}

export function listSdks({ developerDir, platform }) {
  const results = [];
  for (const root of sdkSearchRoots(developerDir, platform)) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      if (!name.endsWith(".sdk")) continue;
      const discoveredPath = join(root, name);
      const settings = readSdkSettings(discoveredPath);
      const path = canonicalSdkPath(discoveredPath, settings);
      results.push({
        path,
        name: settings?.CanonicalName
          ? sdkDisplayName(settings.CanonicalName, settings.Version)
          : name.replace(/\.sdk$/, ""),
        version: settings?.Version ?? null,
        canonicalName: settings?.CanonicalName ?? null,
      });
    }
  }
  return results;
}

export function platformDirectory(developerDir, platform) {
  const dir = PLATFORM_DIRS[platform];
  return dir ? join(developerDir, "Platforms", dir) : null;
}
