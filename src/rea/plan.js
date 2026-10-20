/**
 * Build a concrete REA (https://github.com/morluto/rea) evidence-collection
 * plan for Xcode itself. The commands are deliberately explicit: the user can
 * read, edit, or run them one at a time on the Mac, and every output file maps
 * back to the component it came from.
 */

export const XCODE_COMPONENTS = [
  {
    id: "xcodebuild",
    path: "Contents/Developer/usr/bin/xcodebuild",
    role: "CLI front end; contains build-setting names, flag parsing and error text",
    depth: "full",
  },
  {
    id: "xcbuild",
    path: "Contents/SharedFrameworks/XCBuild.framework/Versions/A/XCBuild",
    role: "The build system: settings evaluation, task graph, compiler invocation",
    depth: "full",
  },
  {
    id: "devtoolscore",
    path: "Contents/SharedFrameworks/DevToolsCore.framework/Versions/A/DevToolsCore",
    role: "Project model and build-setting resolution used by the IDE",
    depth: "full",
  },
  {
    id: "dvtfoundation",
    path: "Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/DVTFoundation",
    role: "Developer-tool infrastructure, platform and SDK discovery",
    depth: "inspect",
  },
  {
    id: "idefoundation",
    path: "Contents/SharedFrameworks/IDEFoundation.framework/Versions/A/IDEFoundation",
    role: "IDE services including scheme and workspace handling",
    depth: "inspect",
  },
  {
    id: "idekit",
    path: "Contents/Frameworks/IDEKit.framework/Versions/A/IDEKit",
    role: "IDE UI; useful for project/settings UI behaviour, not build semantics",
    depth: "inspect",
  },
  {
    id: "xcode",
    path: "Contents/MacOS/Xcode",
    role: "Application entry point and high-level orchestration",
    depth: "inspect",
  },
  {
    id: "actool",
    path: "Contents/Developer/usr/bin/actool",
    role: "Asset catalog compiler invocation and partial Info.plist output",
    depth: "inspect",
  },
  {
    id: "ibtool",
    path: "Contents/Developer/usr/bin/ibtool",
    role: "Interface Builder compiler invocation",
    depth: "inspect",
  },
  {
    id: "swiftc",
    path: "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc",
    role: "Swift driver; how build settings map to driver flags",
    depth: "inspect",
  },
];

const SETTING_PATTERN =
  "(ACTION|ALTERNATE|ARCHS|ASSETCATALOG|BUILT_PRODUCTS_DIR|CLANG|CODE_SIGN|COMBINE_HIDPI|CONFIGURATION|COPY_PHASE|CURRENT_PROJECT|DEBUG_INFORMATION|DEFINES_MODULE|DEPLOYMENT_TARGET|DERIVED|DEVELOPMENT|DYLIB|ENABLE|EXECUTABLE|FRAMEWORK|GCC|GENERATE_INFOPLIST|HEADER_SEARCH|INFOPLIST|IPHONEOS|LD_|LIBRARY_SEARCH|MACOSX|MARKETING|MACH_O|MODULE|MTL|ONLY_ACTIVE|OTHER_|PRODUCT_|PROVISIONING|SDKROOT|SKIP_INSTALL|SWIFT_|TARGETED_DEVICE|TEST_HOST|VALIDATE|WRAPPER)_[A-Z0-9_]+";

function jsonOut(id, suffix) {
  return `${id}.${suffix}.json`;
}

export function buildReaPlan({
  xcodeApp = "/Applications/Xcode.app",
  outDir = "evidence/rea",
  provider = "ghidra",
} = {}) {
  const commands = [];
  for (const component of XCODE_COMPONENTS) {
    const absolute = `${xcodeApp}/${component.path}`;
    commands.push({
      id: `${component.id}-inventory`,
      component: component.id,
      phase: 1,
      purpose: "Inventory, dependencies, architectures, strings and file digests",
      command: `rea inspect-artifact "${absolute}" --format json --full-output > "${outDir}/${jsonOut(component.id, "inventory")}"`,
      output: `${outDir}/${jsonOut(component.id, "inventory")}`,
    });
    commands.push({
      id: `${component.id}-settings-strings`,
      component: component.id,
      phase: 1,
      purpose: "Enumerate build-setting identifiers embedded in the binary",
      command: `rea search "${absolute}" "${SETTING_PATTERN}" --kind strings --mode regex --format json --full-output > "${outDir}/${jsonOut(component.id, "settings")}"`,
      output: `${outDir}/${jsonOut(component.id, "settings")}`,
    });
    if (component.depth === "full") {
      commands.push({
        id: `${component.id}-analyze`,
        component: component.id,
        phase: 2,
        purpose: "Provider-backed function inventory for the build system",
        command: `rea analyze "${absolute}" --provider ${provider} --format json --full-output > "${outDir}/${jsonOut(component.id, "analysis")}"`,
        output: `${outDir}/${jsonOut(component.id, "analysis")}`,
      });
      commands.push({
        id: `${component.id}-dispatch`,
        component: component.id,
        phase: 2,
        purpose: "Objective-C/Swift class, selector and protocol metadata",
        command: `rea inspect-native-dispatch-metadata "${absolute}" --provider ${provider} --format json --full-output > "${outDir}/${jsonOut(component.id, "dispatch")}"`,
        output: `${outDir}/${jsonOut(component.id, "dispatch")}`,
      });
    }
  }

  commands.push({
    id: "xcode-ui",
    component: "xcode",
    phase: 3,
    purpose:
      "Accessibility tree of a running Xcode window (optional; reveals setting labels and grouping)",
    command:
      'rea observe-native-ui "/Applications/Xcode.app" --pid "$(pgrep -x Xcode | head -1)" --window-id "${XCODE_WINDOW_ID:?set XCODE_WINDOW_ID}" --format json --full-output > "evidence/xcode.ui.json"',
    output: "evidence/xcode.ui.json",
  });

  commands.push({
    id: "xcode-ib",
    component: "xcode",
    phase: 3,
    purpose: "Decode compiled Interface Builder documents shipped inside Xcode",
    command:
      `rea decode-interface-builder "${xcodeApp}" --max-documents 32 --max-objects 20000 --format json --full-output > "evidence/xcode.interface-builder.json"`,
    output: "evidence/xcode.interface-builder.json",
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    xcodeApp,
    outDir,
    provider,
    notes: [
      "Run the static commands on macOS; REA can read Xcode without executing it.",
      "Phase 2 requires a configured native provider (Ghidra, Hopper, IDA or Kuna).",
      "Phase 3 is optional and needs a running Xcode window plus Accessibility permission.",
      "xcl also reads the .xcspec files directly: run `xcl spec sync` for authoritative defaults.",
    ],
    settingPattern: SETTING_PATTERN,
    components: XCODE_COMPONENTS.map((component) => ({
      ...component,
      absolutePath: `${xcodeApp}/${component.path}`,
    })),
    commands,
  };
}

export function renderCollectScript(plan) {
  const lines = [
    "#!/bin/bash",
    "# Generated by `xcl rea plan`.",
    "# Collects REA evidence about the local Xcode installation.",
    "set -uo pipefail",
    "",
    'XCODE="${XCODE:-' + plan.xcodeApp + '}"',
    'OUT="${OUT:-evidence/rea}"',
    'PROVIDER="${PROVIDER:-' + plan.provider + '}"',
    "export XCODE OUT PROVIDER",
    "",
    'if ! command -v rea >/dev/null 2>&1; then',
    '  echo "rea not found. Install it with: npm install -g rea-agents" >&2',
    "  exit 1",
    "fi",
    'if [ ! -d "$XCODE" ]; then',
    '  echo "Xcode not found at $XCODE (set XCODE=...)" >&2',
    "  exit 1",
    "fi",
    'mkdir -p "$OUT"',
    'echo "Collecting evidence into $OUT"',
    "",
    "run() {",
    '  local name="$1"; shift',
    '  echo "  -> $name"',
    '  if ! "$@"; then',
    '    echo "     (failed; continuing)" >&2',
    "  fi",
    "}",
    "",
  ];

  for (const entry of plan.commands) {
    const command = entry.command
      .replaceAll(`"${plan.xcodeApp}"`, '"$XCODE"')
      .replaceAll('"${XCODE_WINDOW_ID:?set XCODE_WINDOW_ID}"', '"${XCODE_WINDOW_ID:-}"')
      .replaceAll("--provider ghidra", '--provider "$PROVIDER"')
      .replaceAll(`"${plan.xcodeApp}/`, '"$XCODE/')
      .replaceAll(`"${plan.outDir}/`, '"$OUT/')
      .replaceAll('"evidence/', '"$OUT/');
    if (entry.phase === 3 && entry.id === "xcode-ui") {
      lines.push("# Optional: set XCODE_WINDOW_ID from `xcl rea windows` (or an AX tool).");
    }
    lines.push(`# ${entry.id}: ${entry.purpose}`);
    lines.push(`run "${entry.id}" bash -c '${command.replaceAll("'", "'\\''")}'`);
    lines.push("");
  }

  lines.push('echo "Done. Run: xcl rea import $OUT/*.json"');
  return `${lines.join("\n")}\n`;
}

export function renderReaReadme(plan) {
  return `# Collecting Xcode evidence with REA

Generated by \`xcl rea plan\` for \`${plan.xcodeApp}\`.

This directory describes how to use [REA](https://github.com/morluto/rea) to
answer questions about Xcode that documentation does not answer precisely:

- Which build settings exist in this Xcode version, and what are their defaults?
- How does \`xcodebuild\` resolve settings across project, target, xcconfig and
  command-line layers?
- Which product types and platforms are supported by the installed toolchain?
- How does the IDE group and label settings (for the \`studio\` viewer)?

## Phases

1. **Static inventory and string search** — no provider required. Safe and fast.
2. **Provider-backed analysis** — requires Ghidra, Hopper, IDA or Kuna. Start with
   \`xcodebuild\` and \`XCBuild\`; these contain the build-setting machinery.
3. **Optional UI inspection** — needs a running Xcode and Accessibility permission.

## Run

\`\`\`bash
chmod +x collect.sh
./collect.sh
\`\`\`

Then copy the generated JSON back and import it:

\`\`\`bash
xcl rea import evidence/rea/*.json --out compat/evidence.json
xcl compat report
\`\`\`

## Authority

\`rea inspect-artifact\` proves what is inside the binary; it does not prove
runtime behaviour. Treat imported setting names as *candidates* and confirm
semantics against \`xcodebuild -showBuildSettings\` on the same machine. The
\`compat/report\` command separates evidence-backed names from settings xcl has
implemented and from names that are still unknown.

REA results include evidence identifiers and limitations. Keep the raw JSON;
\`xcl rea import\` stores file hashes so a later import can be audited.
`;
}
