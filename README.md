# xcl — Xcode, without the 40 GB

`xcl` is a lightweight, `xcodebuild`-compatible project and build engine for
macOS, written in dependency-free Node.js. It reads real `.xcodeproj`,
`.xcworkspace`, `.xcscheme` and `.xcconfig` files, resolves build settings the
way Xcode does, and drives `swiftc`/`clang`/`actool`/`ibtool` directly — so you
can list, inspect, and build a normal Xcode project without opening Xcode.

Compatibility work is driven by **[REA](https://github.com/morluto/rea)**: `xcl`
ships an evidence-collection plan that inspects Xcode's own build-system
binaries, imports the observed build-setting names and component facts, and
reports exactly which settings are implemented and which are not. No Apple
binaries are copied or redistributed; the result is new, MIT-licensed code
guided by observed behaviour and Apple's public project format.

```bash
git clone https://github.com/temitayocharles/xcode-rea
cd xcode-rea
node bin/xcl.mjs -project ~/Projects/Hello/Hello.xcodeproj -list
node bin/xcl.mjs -project ~/Projects/Hello/Hello.xcodeproj -scheme Hello \
  -configuration Debug -sdk iphonesimulator build
```

> Status: **0.1.0 — macOS build and signing verified, settings parity incomplete.**
>
> On macOS 27.0.1 / Xcode 27.1, the Apple Silicon HelloXcode fixture passed
> **133/133 Node tests**, project structure, real simulator compilation, bundle
> signing, and arm64 architecture validation. The latest hardware run has
> **0 differing values and 13 missing setting occurrences** across the app
> and test targets. These are occurrences, not unique setting keys. Subsequent
> app/XCTest conditional linker defaults are tested in **132 Node tests**,
> but have not yet been certified on Mac hardware.
> See the [release gate](docs/RELEASE-GATE.md) for evidence boundaries.
>
> Test execution, Swift Package resolution, archives/notarization and Interface
> Builder *editing* are deliberately out of scope. See
> [Known divergences](docs/COMPATIBILITY.md#known-divergences).

---

## Why

Xcode 16 is roughly a 30–40 GB installation and runs a large IDE, an indexer, a
simulator manager and a build daemon. For many jobs — CI, scripted builds,
inspecting someone else's project, or learning how a feature is built — that is
far more machinery than the task needs.

`xcl` takes the opposite approach:

- **One small program.** No daemon, no package install, no native modules. The
  entire tool is a few thousand lines of readable JavaScript.
- **No GUI, no indexer, no simulator management.** It builds products and gets
  out of the way.
- **Works with Command Line Tools.** If you have the ~2 GB CLT install instead
  of full Xcode, `xcl` can still compile macOS Swift/Objective-C projects. Most
  iOS work still needs the iOS SDK that ships with Xcode.
- **Reads the real project format.** It is not a toy format: `objectVersion`
  46–77, `PBXFileSystemSynchronizedRootGroup` (Xcode 16 folder syncing),
  variant groups, per-config xcconfig chains, schemes and workspaces.
- **Learns from the installed Xcode.** When Xcode is present, `xcl` imports the
  build-setting defaults from the local `.xcspec` files and `SDKSettings.plist`
  rather than assuming what they should be.
- **Says what it does not know.** `xcl compat report` compares settings observed
  in Xcode (via REA) with settings `xcl` implements.

## What works

Two independent things are recorded per row: whether the behaviour is
**implemented** (code exists and is exercised by `npm test`) and whether it is
**verified** (produced a working product on macOS via
[`scripts/macos-verify.mjs`](scripts/macos-verify.mjs)). Verification is pending
for every row until that gate is run and its report is committed.

| Area | Implemented | Verified on macOS |
| --- | --- | --- |
| `project.pbxproj` parsing (objectVersion 46–77) | ✅ classic groups, file refs, build phases, dependencies | ⏳ |
| Xcode 16 synchronized folders | ✅ including `membershipExceptions` and per-file compiler flags | ⏳ |
| `.xcconfig` | ✅ `#include`, `#include?`, conditionals, `$(inherited)` | ⏳ |
| Build-setting resolution | ✅ defaults → `.xcspec` → project xcconfig → project → target xcconfig → target → `-xcconfig` → CLI | ⏳ |
| Conditional settings | ✅ `sdk`, `arch`, `config`, `platform`, `variant`, with Xcode's specificity rule | ⏳ |
| SDK/platform discovery | ✅ `SDKSettings.plist`, `.xcspec` defaults, Xcode / CLT detection | ⏳ |
| `-list`, `-list -json` | ✅ targets, configurations, schemes, workspace | ⏳ |
| `-showBuildSettings`, `-json` | ✅ all targets, sorted, xcodebuild-shaped output | ⏳ |
| Schemes and workspaces | ✅ shared/user schemes, container/group references | ⏳ |
| Swift / Objective-C / C / C++ builds | ✅ `swiftc` and `clang` drivers | ⏳ |
| Resources | ✅ asset catalogs (`actool`), storyboards/`xib` (`ibtool`), plists, strings, bundles | ⏳ |
| Info.plist | ✅ process `INFOPLIST_FILE` or generate from `INFOPLIST_KEY_*` | ⏳ |
| Product types | ✅ app, framework, static/dynamic library, tool, app extension, unit/UI test bundle | ⏳ |
| Code signing | ✅ ad-hoc (`-`) signatures; entitlements are passed through | ⏳ |
| Build plans / dry runs | ✅ every command is inspectable, no shell metacharacter surprises | ✅ (platform-independent) |
| Local web UI | ✅ `xcl studio` — project tree, settings, command plan | ✅ (served and queried in CI) |
| `xcodebuild` CLI aliases | ✅ `xcl xcodebuild -project … -scheme … build` | ⏳ |
| Test execution / result bundles | ❌ builds test bundles, does not run XCTest | — |
| Swift Package Manager resolution | ❌ planned; use `swift build` for packages | — |
| Archive / export / notarization | ❌ planned | — |
| Incremental & parallel builds | ❌ currently a deterministic full plan | — |
| Interface Builder / asset editing | ❌ compiles existing files, never edits them | — |
| Simulator install/launch | ❌ use `simctl` directly | — |

## Quick start

### Requirements

- macOS 13+ (Ventura or later recommended)
- Node.js 20.11+
- Xcode or Command Line Tools (`xcode-select -p` must resolve)

Check the machine:

```bash
node bin/xcl.mjs doctor
```

### Use it from this checkout

```bash
# list targets and schemes
node bin/xcl.mjs -project Path/To/App.xcodeproj -list

# inspect every resolved build setting
node bin/xcl.mjs -project Path/To/App.xcodeproj \
  -target App -configuration Debug -sdk iphonesimulator -showBuildSettings

# see exactly what would run, without building
node bin/xcl.mjs -project Path/To/App.xcodeproj \
  -scheme App -configuration Debug -sdk iphonesimulator --dry-run

# build
node bin/xcl.mjs -project Path/To/App.xcodeproj \
  -scheme App -configuration Debug -sdk iphonesimulator build

# open the project browser
node bin/xcl.mjs studio -project Path/To/App.xcodeproj
```

Install the `xcl` command:

```bash
npm link        # from this checkout
xcl --help
```

`xcodebuild`-style invocation also works:

```bash
xcl xcodebuild -project App.xcodeproj -scheme App -configuration Debug build
xcl -project App.xcodeproj -list
xcl -project App.xcodeproj -showBuildSettings
```

### Common flags

| Flag | Meaning |
| --- | --- |
| `-project PATH` | `.xcodeproj` file or directory |
| `-workspace PATH` | `.xcworkspace` file or directory |
| `-scheme NAME` | Build/inspect a scheme |
| `-target NAME` | Build a target (repeatable) |
| `-configuration NAME` | `Debug`, `Release`, or a custom configuration |
| `-sdk NAME` | `iphoneos`, `iphonesimulator`, `macosx`, or a path |
| `-destination SPEC` | e.g. `platform=iOS Simulator,name=iPhone 16` |
| `-derivedDataPath PATH` | Products and intermediates location |
| `-xcconfig PATH` | Additional settings file (highest file-level precedence) |
| `-arch ARCH` | `arm64` or `x86_64` |
| `-dry-run` | Print the plan; execute nothing |
| `-json` | Machine-readable output |
| `-quiet` / `-verbose` | Less / more output |
| `KEY=VALUE` | Highest-precedence setting override |

## How it works

```text
                     ┌────────────────────────────────────────────┐
  .xcodeproj ───────▶│ plist parsers (OpenStep / XML / binary)    │
  .xcworkspace ─────▶│ Xcode project model                       │
  .xcscheme ────────▶│ targets, phases, synced folders, schemes  │
  .xcconfig ────────▶│ layered settings resolver                 │
  .xcspec / SDK ────▶│ Xcode defaults + SDK DefaultProperties    │
                     └───────────────┬────────────────────────────┘
                                     │ JSON settings
                                     ▼
                     ┌────────────────────────────────────────────┐
                     │ build planner                              │
                     │ mkdir → compile → link → resources →       │
                     │ Info.plist → embed → codesign              │
                     └───────────────┬────────────────────────────┘
                                     │ explicit argv commands
                                     ▼
                     xcrun swiftc / clang / actool / ibtool / codesign
```

There is no shell interpolation in the plan: every step is an executable plus
an argument array. `--dry-run` prints the same commands that `build` executes.

### Setting resolution

`xcl` follows Xcode's documented order (lowest to highest):

1. Platform, SDK and product-type defaults
2. Project `.xcconfig`
3. Project build settings
4. Target `.xcconfig`
5. Target build settings
6. `-xcconfig`
7. Command-line `KEY=VALUE`

Within one level, a conditional definition with more matching conditions wins
(`OTHER_LDFLAGS[sdk=iphonesimulator*]` beats `OTHER_LDFLAGS`), and the last
definition with equal conditions wins. `$(inherited)` refers to the value from
lower levels only — exactly the behaviour that trips people up in real xcconfig
files.

## Using REA to keep it honest

The point of this repository is not just to guess Xcode's behaviour. It ships a
repeatable way to **measure** it and then prove coverage.

```bash
# 1. Generate a plan that inspects your local Xcode with REA
xcl rea plan

# 2. Run it on the Mac (REA must be installed: npm i -g rea-agents)
./evidence/rea/collect.sh

# 3. Import the evidence and see coverage
xcl rea import evidence/rea/*.json
xcl compat report
```

`xcl rea plan` targets the binaries that actually implement the build system:
`xcodebuild`, `XCBuild.framework`, `DevToolsCore.framework`,
`DVTFoundation.framework`, `IDEFoundation.framework`, `actool`, `ibtool` and the
Swift driver. For each one it emits inventory, string-search, native-analysis
and Objective-C/Swift dispatch-metadata commands, plus an optional
accessibility-tree capture of a running Xcode window.

The import is deliberately conservative: it records setting-name candidates with
observation counts and file hashes, never claims runtime behaviour, and keeps
unknown names visible in `compat report` instead of silently pretending they
work. See [docs/REA-WORKFLOW.md](docs/REA-WORKFLOW.md) for the full loop and the
authority limits of each command.

## xcl studio

`xcl studio` serves a small local web UI on `http://0.0.0.0:4173`:

- project targets and product kinds
- every resolved build setting, searchable
- the exact build plan for the selected configuration/platform
- source and resource inventory, including synchronized folders

It binds to all interfaces so it also works in containers and remote dev
environments; pass `--host 127.0.0.1` if you want it loopback-only.

## Compatibility reporting

```bash
xcl spec sync          # import .xcspec defaults from the installed Xcode
xcl compat report      # compare REA observations with implemented settings
xcl doctor             # toolchain, SDKs, specs, evidence state
```

`xcl` also reads `SDKSettings.plist` `DefaultProperties` directly, so values such
as `ARCHS_STANDARD`, deployment targets and signing defaults come from the SDK
you actually have installed.

## Repository layout

```text
bin/xcl.mjs                 CLI entry point
src/cli/                    argument parsing and project context
src/plist/                  OpenStep, XML and binary plist parsers
src/xcode/                  pbxproj, xcconfig, scheme and workspace models
src/settings/               defaults, product types, toolchain, specs, resolver
src/engine/                  build planner and executor
src/rea/                    REA evidence plan and importer
src/compat/                 coverage report
src/studio/                 local web UI
tests/                      fixtures and node:test suite
docs/                       compatibility notes and REA workflow
```

## Verification status

Claims here are deliberately split into two levels:

- **Implemented** — the code exists and `npm test` exercises it.
- **Verified** — the behaviour was reproduced against real Xcode for a real
  project on macOS.

An Apple Silicon Mac running Xcode 27.1 has successfully built, signed,
and passed architecture verification for the HelloXcode fixture. Its last
full hardware certification reported **0 differing values and 13 missing
setting occurrences** across the application and test targets. Full
`-showBuildSettings` parity remains unverified. Subsequent changes derive
WORKSPACE_DIR from the selected project/workspace, expose the documented
deep-bundle relative suffixes and simulator provisioning requirements.
The existing one-command verifier now reports only non-sensitive provisioning
capabilities and structural shapes of selected cache paths without printing
private roots or digests. **129/129 Node regressions pass in isolation**;
the post-fix Mac settings parity remains unmeasured. Private signing
identities, dynamic SDK cache hashes and Xcode internals are not fabricated.

For one complete Mac regression, build and differential check:

```bash
npm run certify:mac
```

This writes `docs/verification/macOS-final.json`, prints a redacted grouped
summary of unresolved settings, and exits nonzero unless **every** gate passes.

That command compares `-list` and every resolved build setting with
`xcodebuild`, runs an actual `xcl build` in an isolated DerivedData directory,
then checks the product is a valid, signed bundle with an executable of the
expected architecture. It exits non-zero on any difference.

See [docs/RELEASE-GATE.md](docs/RELEASE-GATE.md) for what each gate proves, what
it does not, and the repository-integrity checks that keep source files from
silently disappearing from a commit.

## Development

```bash
npm test                    # 137 tests, no dependencies, ~3 seconds
npm run demo                # list the fixture project
npm run demo:settings       # resolve settings for the fixture
npm run demo:plan           # print a build plan
```

The fixtures cover a classic Xcode 15 app (`HelloXcode`), an Xcode 16
synchronized-folder project (`ModernSync`) and an xcconfig inheritance chain
(`ConfigChains`). Tests validate parsing, layering, conditions, planning, CLI
output shapes, evidence import and the REA plan generator.

Beyond the fixtures, the parser and planner are exercised against real
open-source projects: Alamofire (objectVersion 77, ten cross-platform targets),
Kingfisher (objectVersion 54, group-relative and `SOURCE_ROOT` references) and
IceCubesApp (objectVersion 70, synchronized root groups and Swift Package
dependencies). These are downloaded on demand and are not vendored here.

## Design principles

1. **Evidence over guesses.** Where Xcode's behaviour is undocumented, measure it
   with REA and record the source.
2. **Read, don't write, project files.** `xcl` is not a project editor. It never
   rewrites your `.pbxproj`.
3. **No hidden execution.** A build is a printed list of argv commands. Dry runs
   are byte-for-byte what execution runs.
4. **Small surface, honest failures.** Unsupported features say so and point at
   the right tool instead of producing subtly wrong output.

## Legal and safety

`xcl` is an independent MIT-licensed implementation. It does not include,
modify, or redistribute Apple binaries or SDK content. It reads the copy of
Xcode installed on your machine, at your direction, through Apple's own tools.

Reverse engineering may be restricted by the software licence you accepted and
by local law. The REA plan only performs static inspection of files you already
have; it does not bypass code signing, DRM or licence checks. You are
responsible for how you use it. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
