# Architecture

`xcl` is a pipeline of small, independently testable modules. Nothing in the
build path depends on a GUI, a daemon, or a native addon.

```text
                       ┌──────────────────────────┐
  argv ──▶ cli/parser  │ command + flags + KV     │
                       └────────────┬─────────────┘
                                    ▼
                       ┌──────────────────────────┐
                       │ cli/context              │
                       │ project/workspace loader │
                       │ scheme + target select   │
                       │ toolchain + SDK + arch   │
                       └────────────┬─────────────┘
                                    ▼
   .pbxproj ──▶ xcode/pbxproj ──┐
   .xcconfig ─▶ xcode/xcconfig ─┤
   .xcspec ───▶ settings/spec ──┼──▶ settings/resolver ──▶ flat settings map
   SDKSettings ▶ settings/toolchain ┘
                                    ▼
                       ┌──────────────────────────┐
                       │ build/plan               │
                       │ steps: mkdir, compile,   │
                       │ link, resource, bundle,  │
                       │ sign, script             │
                       └────────────┬─────────────┘
                                    ▼
                       ┌──────────────────────────┐
                       │ build/execute            │
                       │ spawn per step           │
                       │ internal plist commands  │
                       └──────────────────────────┘
```

## Modules

### `src/plist`

- `openstep.js` — lexer/parser/serializer for the old-style plist dialect used
  by `.pbxproj` and `.xcspec`. Tracks line/column for diagnostics.
- `xml.js` — minimal XML reader for schemes, workspaces and XML plists.
- `binary.js` — `bplist00` reader used by `SDKSettings.plist` and Info.plists.
- `index.js` — format detection, XML plist conversion, XML writer.

### `src/xcode`

- `pbxproj.js` — project model. Resolves groups to paths, expands build files,
  handles variant groups and synchronized folders, exposes targets, phases,
  dependencies and product paths.
- `xcconfig.js` — includes, comments, conditional keys, continuation lines.
- `scheme.js` — Build/Test/Launch/Profile/Analyze/Archive actions and buildable
  references.
- `workspace.js` — `contents.xcworkspacedata`, group/container/absolute
  references, scheme discovery (shared and user).

### `src/settings`

- `defaults.js` — curated generic, platform and product layout defaults;
  deterministic DerivedData path; deployment-target selection.
- `productTypes.js` — product-type → wrapper/Mach-O/paths/extra settings.
- `toolchain.js` — developer directory detection (`DEVELOPER_DIR`,
  `xcode-select`, well-known paths), SDK enumeration and `SDKSettings.plist`
  parsing.
- `spec.js` — recursive `.xcspec` reader with caching and platform filtering.
- `resolver.js` — layered merge, condition matching, specificity, `$(inherited)`,
  recursive expansion and modifiers.

### `src/engine`

- `plan.js` — turns a target + settings into an ordered list of exec steps.
  Paths come from resolved settings (`EXECUTABLE_PATH`,
  `UNLOCALIZED_RESOURCES_FOLDER_PATH`, `INFOPLIST_PATH`, `FRAMEWORKS_FOLDER_PATH`),
  so macOS vs iOS layout is data, not branching.
- `execute.js` — spawns each step with an explicit argv array; implements the
  three internal steps (`generate-info-plist`, `process-info-plist`,
  `write-pkginfo`); refuses to run `xcrun` off macOS.

### `src/rea`

- `plan.js` — component catalogue and command generation for Xcode inspection.
- `import.js` — conservative candidate extraction and evidence merging.
- `cli.js` — `xcl rea plan|import|status|summary|windows`.

### `src/studio`

- `server.js` — `node:http` server with `/api/project`, `/api/settings`,
  `/api/plan`.
- `index.html` — self-contained UI (no build step, no CDN).

## Invariants

- **No shell in plans.** Every step is `{tool, args}`. Quoting is for display
  only. `--dry-run` and `build` share the same plan object.
- **Settings are strings.** Expansion produces the exact strings passed to
  tools; no implicit arrays or booleans.
- **Read-only project access.** No module writes to `.xcodeproj`, `.xcworkspace`
  or `.xcconfig`.
- **Deterministic output.** Sorted settings, sorted evidence keys, stable paths.
  This makes CLI snapshots and compatibility diffs meaningful.
- **Fail closed.** Unknown internal steps and non-macOS tool invocations throw
  `BuildError` with the failing command.

## Extending

To add a product type:

1. Add an entry to `PRODUCT_TYPES` with wrapper extension, Mach-O type, paths
   and extra settings.
2. Add a fixture target if the build path differs.
3. Add a plan test asserting the executable and resource destinations.

To add a build setting:

1. Add it to `genericDefaults` or `platformDefaults` with the correct layer.
2. If it is conditional or list-like, add a resolver test.
3. If it changes the plan, add a build test.
4. Run `xcl compat report` against your own evidence to see whether it was
   previously listed as missing.

To add a CLI flag:

1. Register it in `BOOLEAN_FLAGS` or `VALUE_FLAGS` in `cli/parser.js`.
2. Map it in `cli/context.js` (platform, arch, overrides, paths).
3. Add a CLI test in `tests/cli.test.js`.
