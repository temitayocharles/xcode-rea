import { basename, join, resolve, sep } from "node:path";

/**
 * xcodebuild rejects -scheme together with -target. Differential settings
 * checks select each target explicitly in both tools.
 */
export function referenceSettingsArgs(options, target) {
  if (!options.project || !target) throw new Error("project and target are required");
  // -derivedDataPath requires -scheme in xcodebuild; target-level queries
  // cannot use it. Instead pin the two canonical build roots on BOTH sides
  // of the differential test so path comparisons are meaningful.
  const base = [
    "-project", options.project,
    "-target", target,
    "-configuration", options.configuration,
    "-sdk", options.sdk,
    "-showBuildSettings", "-json",
  ];
  if (options.derivedData) {
    base.push(
      `SYMROOT=${join(options.derivedData, "Build", "Products")}`,
      `OBJROOT=${join(options.derivedData, "Build", "Intermediates.noindex")}`,
    );
  }
  return base;
}

/**
 * The verifier creates fresh, isolated run directories under a clearly named
 * parent. It never recursively deletes caller-provided paths.
 */
export function assertVerificationRoot(directory, repoRoot, project) {
  const root = resolve(directory);
  const base = basename(root);
  if (base !== ".verify-derived-data" && base !== "xcl-verify" && !/^xcl-verify-[A-Za-z0-9_.-]+$/.test(base)) {
    throw new Error("verification DerivedData must be named .verify-derived-data or xcl-verify-*");
  }
  const protectedPaths = [resolve(repoRoot), resolve(project)];
  if (protectedPaths.some((path) => path === root || path.startsWith(root + sep))) {
    throw new Error("verification DerivedData may not contain the repository or Xcode project");
  }
  return root;
}
