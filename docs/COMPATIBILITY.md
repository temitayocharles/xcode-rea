# Compatibility notes

This document records what `xcl` implements, how it matches Xcode, and where it
deliberately diverges. It is the reference for the claims in the README.

## Project format

| Feature | Notes |
| --- | --- |
| OpenStep property lists | Comments, quoted/unquoted strings, data, escapes, BOM |
| `objectVersion` 46–77 | Parsed generically; no schema whitelist |
| `PBXGroup` / `PBXFileReference` | `sourceTree` handling: `<group>`, `SOURCE_ROOT`, `<absolute>`, `BUILT_PRODUCTS_DIR`, `SDKROOT`, `DEVELOPER_DIR` |
| `PBXVariantGroup` | Localized resources expand to child references with `.lproj` paths |
| `PBXFileSystemSynchronizedRootGroup` | Directory scan, bundle detection, `membershipExceptions`, `additionalCompilerFlagsByRelativePath` |
| Build phases | Sources, Frameworks, Resources, Copy Files, Shell Script, Headers |
| Dependencies | `PBXTargetDependency` + `PBXContainerItemProxy`, topological ordering |
| Product references | Resolved from `BUILT_PRODUCTS_DIR` and the target's product type |
| Configuration lists | Default configuration, per-config settings, base xcconfig |

`xcl` never writes a `.pbxproj`. There is no round-trip risk to your project.

## Build setting resolution

The layer order is:

```text
generic defaults
platform + SDK DefaultProperties
product-type defaults
project xcconfig
project build settings
target xcconfig
target build settings
-xcconfig
command-line KEY=VALUE
```

Implementation details that match Xcode:

- **Conditional specificity.** For one setting at one level, the matching
  definition with the most conditions wins. Equal conditions: last definition
  wins. This matches Apple's xcconfig reference and the NSHipster/Xcode
  documentation on conditional settings.
- **`$(inherited)`** resolves against the value from lower levels only, not
  earlier assignments in the same file. This is the single most common source of
  wrong clones.
- **Includes.** `#include "path"` and `#include? "path"` are resolved relative to
  the including file; cycles are reported instead of hanging.
- **Recursive expansion.** `$(SETTING)` and `${SETTING}` expand recursively with
  cycle protection. Unknown settings expand to the empty string, like
  `xcodebuild`.
- **Modifiers.** `:lower`, `:upper`, `:identifier`, `:rfc1034identifier`,
  `:c99extidentifier`, `:file`, `:dir`, `:base`, `:suffix`, `:standardizepath`,
  `:quote`, `:default=…`.
- **Whitespace.** Runs of spaces outside quotes collapse; values are trimmed.

### Defaults sources

1. Hand-curated defaults in `src/settings/defaults.js`, based on Xcode's public
   build-setting reference and project templates.
2. `SDKSettings.plist` `DefaultProperties` from the selected SDK.
3. `.xcspec` `DefaultValue` entries in the installed Xcode
   (`xcl spec sync`, or automatic when Xcode is present and
   `XCL_SKIP_SPECS=1` is not set).

That ordering means an installed Xcode can correct `xcl`'s assumptions without a
code change. Parsed specs are cached in `~/Library/Caches/xcl/xcspec-*.json`
(override with `XCL_CACHE_DIR`, disable with `XCL_NO_CACHE=1`), so the scan runs
once per Xcode version rather than once per build. `XCL_SKIP_SPECS=1` is useful
for reproducing built-in behaviour in tests or on machines with a partially
installed Xcode.

`XCODE_VERSION`, `XCODE_VERSION_MAJOR`, `XCODE_VERSION_MINOR` and
`XCODE_VERSION_ACTUAL` are synthesised from the installed toolchain, because real
projects reference them in setting values:

```text
MACOSX_DEPLOYMENT_TARGET = "$(MACOSX_DEPLOYMENT_TARGET_XCODE_$(XCODE_VERSION_MAJOR))"
```

References nested inside a setting *name* are expanded before lookup, matching
Xcode.

File-valued settings (`INFOPLIST_FILE`, `CODE_SIGN_ENTITLEMENTS`,
`SWIFT_OBJC_BRIDGING_HEADER`) are resolved against `SRCROOT` when they are
relative, which is what Xcode does; other settings (such as
`EXECUTABLE_PATH`) remain relative to `TARGET_BUILD_DIR`.

## CLI compatibility

| xcodebuild | xcl | Notes |
| --- | --- | --- |
| `-project` | ✅ | file or directory |
| `-workspace` | ✅ | group/container/absolute refs |
| `-scheme` | ✅ | shared and user schemes |
| `-target` | ✅ | repeatable |
| `-configuration` | ✅ | validated by project configs |
| `-sdk` | ✅ | name or path; latest matching SDK |
| `-destination` | ⚠️ | platform/name/id/arch parsed; device selection is not used to install or launch |
| `-derivedDataPath` | ✅ | default is deterministic but not Xcode's hash |
| `-xcconfig` | ✅ | applied above target settings |
| `-arch` | ✅ | single-arch builds |
| `-list` | ✅ | text and `-json` |
| `-showBuildSettings` | ✅ | all targets, text and `-json` |
| `-showdestinations` | ⚠️ | lists installed SDKs, not simulator devices |
| `build` | ✅ | Swift/ObjC/clang/Metal, resources, plists, signing |
| `clean` | ✅ | removes products and target temp dirs |
| `test` / `run` / `install` | ❌ | explicit “not implemented” error |
| `archive` / `export` | ❌ | not implemented |
| `-resultBundlePath` | ❌ | accepted but ignored |

`xcl` accepts both `-flag` and `--flag`, and `xcl xcodebuild …` as an alias.

## Product types

Implemented wrapper layouts:

| Product type | Extension | Mach-O | Notes |
| --- | --- | --- | --- |
| application | `.app` | `mh_execute` | iOS flat layout, macOS `Contents/` layout |
| framework | `.framework` | `mh_dylib` | flat layout on both platforms |
| framework.static | `.framework` | `staticlib` | archives objects |
| library.static | `.a` | `staticlib` | `libtool -static` |
| library.dynamic | `.dylib` | `mh_dylib` | flat |
| bundle.unit-test | `.xctest` | `mh_bundle` | built with `-emit-library` (see divergences) |
| bundle.ui-testing | `.xctest` | `mh_bundle` | builds, does not run |
| app-extension | `.appex` | `mh_bundle` | `APPLICATION_EXTENSION_API_ONLY=YES` default |
| bundle | `.bundle` | `mh_bundle` | resources only |
| tool | none | `mh_execute` | plain executable |
| xpc-service | `.xpc` | `mh_execute` | macOS layout |
| bundle.metal | `.metallib` | — | planning only |

## Compilation

- **Swift:** one `swiftc` driver invocation (whole-module) using
  `SWIFT_MODULE_NAME`, `SWIFT_VERSION`, `SWIFT_OPTIMIZATION_LEVEL`,
  `SWIFT_ACTIVE_COMPILATION_CONDITIONS`, `SWIFT_INCLUDE_PATHS`,
  `SWIFT_OBJC_BRIDGING_HEADER`, `OTHER_SWIFT_FLAGS`, search paths, defines and
  runpaths.
- **Clang:** per-file `clang -c` with `-x` language, ARC/weak flags for
  Objective-C, `GCC_C_LANGUAGE_STANDARD` or `CLANG_CXX_LANGUAGE_STANDARD`,
  `GCC_PREPROCESSOR_DEFINITIONS`, `OTHER_CFLAGS`, header/framework search paths,
  optimization and debug info.
- **Metal:** `metal -c` then `metallib`.
- **Linking:** `swiftc` when Swift sources exist; `clang` otherwise; `libtool`
  for static archives. Frameworks become `-F` + `-framework`; `.tbd`/`.dylib`/`.a`
  become direct inputs.
- **Targets:** `<arch>-apple-<platform><deployment>[-simulator]`.

## Resources and bundles

- Asset catalogs: one `actool` invocation receives all resource-phase
  `.xcassets` catalogs, including previews, plus global app-icon/accent-color
  settings; a single partial Info.plist is merged into the app's Info.plist
  before signing.
- Storyboards/xibs: `ibtool --compile`.
- `.strings`/`.plist`: `plutil -convert binary1`.
- Other resources: recursive copy preserving `.lproj` directories.
- Info.plist: processed with variable expansion, or generated from
  `INFOPLIST_KEY_*` (including `_Generation` keys for launch screens and scene
  manifests).
- `PkgInfo` (`APPL????`) for macOS application bundles.
- Ad-hoc `codesign` by default; `CODE_SIGNING_ALLOWED=NO` skips signing;
  entitlements are passed through.

## Known divergences

These are intentional and documented rather than hidden:

1. **DerivedData hash.** Xcode's default DerivedData folder name uses an
   internal hash. `xcl` uses a deterministic SHA-256-derived suffix. Pass
   `-derivedDataPath` when exact parity matters.
2. **Whole-module Swift.** Debug builds compile all Swift files in one driver
   invocation instead of per-file incremental compilation. Correct output,
   slower incremental iteration.
3. **No build database / incrementality.** Every build is a full plan. Steps are
   deterministic so external caching is possible later.
4. **Test bundles.** Built with `-emit-library`; the produced bundle loads as a
   dynamic library rather than using Xcode's exact `-bundle` link flags. XCTest
   execution is not implemented.
5. **macOS frameworks** use a flat `Foo.framework/Foo` layout (with
   `Info.plist` and resources at the framework root) instead of `Versions/A`
   with symlinks. macOS applications, app extensions, XPC services, loadable
   bundles and test bundles do use the `Contents/` layout.
6. **Preview assets** are compiled in every configuration instead of being
   filtered out of Release via `DEVELOPMENT_ASSET_PATHS`.
7. **`-destination`** influences platform/arch selection but does not install or
   launch simulator apps.
8. **No Swift Package Manager.** Package products are parsed and named in a
   build warning, but not built; use `swift build` for package-first projects.
9. **No archives, dSYM bundles, bitcode, or notarization.**
10. **No Interface Builder editing, asset editing, or project writing.**

## Verification strategy

Every claim in this document is covered by at least one test in `tests/`:

- `plist.test.js` — all three plist formats, escaping, round-trips.
- `project.test.js` — classic and synchronized projects, dependencies, schemes,
  workspaces.
- `settings.test.js` — layering, specificity, includes, modifiers, product
  defaults, macOS layout.
- `build.test.js` — plan shape, Swift flags, asset catalogs, Info.plist, macOS
  layout, dependency ordering.
- `cli.test.js` — CLI shapes, aliases, dry runs, evidence commands.
- `rea.test.js` — plan generation, script shape, import heuristics, merging.

Run `npm test`.
