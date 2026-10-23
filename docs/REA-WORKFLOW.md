# Reverse engineering Xcode with REA

`xcl` is not a copy of Xcode's source. It is a behaviour-compatible
implementation built from three kinds of evidence:

1. **Public formats and documentation** — the `.pbxproj` OpenStep dialect,
   `.xcscheme` XML, xcconfig syntax and Apple's build-setting reference.
2. **The installed toolchain's own data** — `.xcspec` files, `SDKSettings.plist`
   and platform metadata, read directly.
3. **REA observations** — names, classes and relationships embedded in Xcode's
   build-system binaries, used to find settings and components that
   documentation does not enumerate.

This document explains the third part: how to collect it, what it can prove, and
how `xcl` consumes it.

## What REA is

[REA (Reverse Engineer Anything)](https://github.com/morluto/rea) is an MCP
server and CLI for inspecting binaries, applications and runtime behaviour. It
can read a Mach-O binary, enumerate Objective-C/Swift dispatch metadata, search
strings, and drive provider-backed analysis (Ghidra, Hopper, IDA, Kuna) — all
without executing the target.

Install it on the Mac:

```bash
npm install -g rea-agents
rea --help
```

For provider-backed commands, configure Hopper, Ghidra or IDA first; see REA's
installation guide. Static inventory and string search need no provider.

## Why Xcode's binaries

The observable surface of `xcodebuild` is large but not self-describing:

- `xcodebuild -showBuildSettings` shows the *resolved* values for one project and
  one configuration. It does not list every setting the build system knows, nor
  the defaults for platforms you have not configured.
- The `/Applications/Xcode.app/Contents/Developer` tree contains `.xcspec` files
  with defaults, but the mapping from spec entries to runtime behaviour (and the
  precedence rules for conditional settings) lives in code.
- Error messages, flag names and product-type identifiers are embedded strings
  in `xcodebuild`, `XCBuild.framework` and `DevToolsCore.framework`.

REA lets us enumerate those strings and class/selector relationships with
provenance, then compare them to what `xcl` implements.

## The loop

### 1. Generate a plan

```bash
xcl rea plan
```

This writes:

```text
evidence/rea/plan.json      machine-readable command list and component map
evidence/rea/collect.sh     runnable collector
evidence/rea/README.md      this workflow, scoped to the local Xcode path
```

The plan covers:

| Component | Why |
| --- | --- |
| `Contents/Developer/usr/bin/xcodebuild` | CLI surface, flags, setting names, error text |
| `XCBuild.framework/Versions/A/XCBuild` | The actual build-system engine |
| `DevToolsCore.framework` | Project model and setting resolution in the IDE |
| `DVTFoundation.framework` | Platform/SDK discovery infrastructure |
| `IDEFoundation.framework` | Scheme and workspace handling |
| `IDEKit.framework` | Settings UI labels (for studio grouping) |
| `Contents/MacOS/Xcode` | Entry point and orchestration |
| `actool`, `ibtool`, `swiftc` | How settings become compiler invocations |

### 2. Run it

```bash
chmod +x evidence/rea/collect.sh
./evidence/rea/collect.sh
```

The script is deliberately boring: `rea … --format json --full-output > file`,
one component and one question at a time. Failures are reported and skipped, so
a missing provider does not stop the static inventory.

The phases are:

1. **Static inventory and setting-name search** — safe, fast, no provider.
2. **Provider analysis and dispatch metadata** — needs Ghidra/Hopper/IDA/Kuna.
   Start with `xcodebuild` and `XCBuild`; they are the settings machinery.
3. **Optional UI capture** — `rea observe-native-ui` needs a running Xcode, a
   window ID and Accessibility permission. Use `xcl rea windows` for hints.

### 3. Import

```bash
xcl rea import evidence/rea/*.json
xcl compat report
```

Import records, for every candidate build-setting name:

- observation count
- source files (base names)
- SHA-256 of each source file

It also records framework and library names, and capitalized class-name
candidates. The file is written to `compat/evidence.json` (ignored by Git by
default, because it is machine- and Xcode-version-specific).

### 4. Act on the report

```bash
xcl compat report
```

```text
xcl compatibility report
  built-in settings: 154
  evidence-backed settings: 412 (154 implemented, 37%)
Settings observed in Xcode but not yet implemented (258):
  SWIFT_UPCOMING_FEATURE_...
  ...
```

Each name in the “not yet implemented” list is a candidate. Decide whether it is:

- a real build setting (`SWIFT_*`, `CLANG_*`, `ASSETCATALOG_*`),
- an internal constant or error code (reject),
- a setting that only matters to the IDE (document, do not implement).

Then add it to `src/settings/defaults.js` or a spec-backed layer, add a test, and
re-run the report. This is the compatibility ratchet.

## Authority and limits

| REA command | Proves | Does not prove |
| --- | --- | --- |
| `inspect-artifact` | File layout, architectures, dependencies, hashes | Runtime behaviour |
| `search --kind strings` | A string exists in the binary | That it is a build setting or is used |
| `inspect-native-dispatch-metadata` | Objective-C/Swift class and selector metadata | Which selector runs for a given build |
| `analyze` (provider) | Function inventory and call graph candidates | Dynamic dispatch or reachability |
| `decompile` | Provider pseudo-code for one function | Source-equivalent semantics |
| `observe-native-ui` | Accessibility tree of one window | Internal settings model |

Consequences for `xcl`:

- A setting name found by string search is a **candidate**, not a confirmed
  setting. `xcl compat report` labels it that way.
- Static analysis cannot tell us the precedence algorithm. That came from
  Apple's documented layering plus black-box observation of `xcodebuild`
  (`-showBuildSettings` with crafted xcconfigs). The tests in
  `tests/settings.test.js` encode those observations.
- The plan never executes Xcode's code. It reads files. It does not bypass
  signing, licensing or DRM.

## Black-box confirmation on the Mac

For semantics, the strongest evidence is still a differential test:

```bash
cat > /tmp/Probe.xcconfig <<'EOF'
OTHER_LDFLAGS = $(inherited) -lbase
OTHER_LDFLAGS[sdk=iphonesimulator*] = $(inherited) -lsim
EOF

xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -xcconfig /tmp/Probe.xcconfig \
  -showBuildSettings | grep OTHER_LDFLAGS

xcl -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -xcconfig /tmp/Probe.xcconfig \
  -showBuildSettings | grep OTHER_LDFLAGS
```

Diff the two outputs. When they differ, reduce the probe until the rule is
clear, add a fixture to `tests/fixtures/`, and encode it in a test. This is how
the conditional-specificity and `$(inherited)` rules in this repository were
established.

## What to inspect next

High-value targets, in order:

1. **`xcodebuild` string tables** for settings and flags that `xcl` does not
   model (`SWIFT_UPCOMING_FEATURE_*`, `ENABLE_*`, `MTL_*`).
2. **`XCBuild`** for product-type identifiers and task names. Compare with
   `src/settings/productTypes.js`.
3. **`DevToolsCore`** for project-model selectors: `PBXFileSystemSynchronized*`,
   `XCConfigurationList`, scheme resolution.
4. **`swiftc` driver** for the mapping from `SWIFT_*` settings to flags. This is
   the most useful next step for build parity.
5. **Accessibility tree** of Xcode's Build Settings editor to recover setting
   display names, categories and defaults shown in the UI (useful for `studio`).

## Reproducibility

Evidence is version-specific. `plan.json` and `compat/evidence.json` record the
Xcode version and file hashes. When you upgrade Xcode:

```bash
xcl rea plan --out evidence/rea-$(xcodebuild -version | head -1 | tr ' ' '-')
./evidence/rea-*/collect.sh
xcl rea import evidence/rea-*/*.json --out compat/evidence-$(xcodebuild -version | head -1).json
```

Keep the raw JSON. A compatibility claim without a hash and a version is just a
rumour.
