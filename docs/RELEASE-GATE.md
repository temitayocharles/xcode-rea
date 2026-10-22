# Release gate

A branch is releasable only when all four gates pass **on a fresh clone**. Gates
1 and 2 run anywhere; gates 3 and 4 require macOS with Xcode installed.

```bash
git clone -b arena/20d2483d-xcode-rea https://github.com/temitayocharles/xcode-rea && cd xcode-rea
npm run certify:mac
```

`certify:mac` runs all Node tests followed by the HelloXcode fixture's real
macOS structural and settings comparison, application build, and signed product
checks. It writes `docs/verification/macOS-final.json`; if settings differ,
it prints a value-redacted categorization and returns nonzero. It never treats
a successful build alone as full settings certification.

## Gate 1 — completeness

The checkout must contain every module the tests and the package manifest refer
to, and no source file may be hidden by an ignore rule.

```bash
npm test -- --test-name-pattern="integrity|committed|ignore|resolves"
```

`tests/integrity.test.js` enforces:

- every relative import in `src/`, `bin/`, `scripts/` and `tests/` resolves;
- every `bin`/`exports`/script target in `package.json` exists;
- every file under the shipped roots is tracked by Git;
- no source directory is matched by `.gitignore` (checked with
  `git check-ignore --no-index`, so it works before a directory has files).

This gate exists because of a real failure: a `.gitignore` line of `build/`
matched `src/build/`, so `git add -A` silently skipped the planner and executor.
Tests passed locally — where the files existed — and the branch could not run.
Directory ignore rules are now root-anchored (`/build/`, not `build/`), and the
build code lives in `src/engine/` so no conventional ignore pattern can reach it.

## Gate 2 — the suite

```bash
npm test
```

Expected: all tests pass, no network, no dependencies, under a few seconds.
Tests cover plist parsing, project models, setting resolution, plan shape, CLI
contracts, the REA plan/importer, the differential diff logic and repository
integrity.

## Gate 3 — real build on macOS

`scripts/macos-verify.mjs` runs the differential comparison and then an actual
build:

1. **structure** — `xcodebuild -list -json` and `xcl -list --json` produce the
   same targets, configurations and schemes.
2. **settings** — for each target, `xcodebuild -showBuildSettings` and
   `xcl -showBuildSettings` are compared key by key using matching product and
   object roots. Target-only Xcode queries do not permit `-derivedDataPath`,
   so `SYMROOT` and `OBJROOT` are set explicitly for the reference call.
   Only deliberately ignored keys (known environment stamps, process
   environment) are excluded. Missing and differing settings fail the gate.
3. **build** — `xcl build` runs in a new unique directory beneath the
   named `--derived-data` root; existing output is never recursively deleted.
4. **product** — the resulting bundle has a valid `Info.plist`, passes
   `codesign --verify --deep --strict`, and contains an executable whose
   architecture matches the architecture in the build plan (checked via `lipo -archs`).

```bash
node scripts/macos-verify.mjs \
  --project ~/Dev/App.xcodeproj \
  --scheme App \
  --configuration Debug \
  --sdk iphonesimulator \
  --derived-data /tmp/xcl-verify \
  --json /tmp/xcl-verify.json
```

For a failed settings gate, the JSON report includes the compared/missing/differing
counts and a complete `differences` array with target, key, and Xcode's
expected value even for missing settings (plus `xcl`'s value where
different). Its `lines` summary is deliberately limited to
avoid overwhelming the console. Review the report for local paths, identities,
and other machine-specific details before sharing it or committing it.

Exit codes: `0` all gates passed, `1` a gate failed, `2` precondition missing
(not macOS, no project, wrong directory). Use `--skip-build` when you only want the comparison (reported as
`settings-only`, **not** full build certification). The output root must be
named `.verify-derived-data`, `xcl-verify`, or `xcl-verify-*`. Use
`--ignore-key NAME` for a setting that is expected to differ.

The pure comparison rules live in `src/compat/diff.js` and are unit-tested on
every platform, so a Linux CI job verifies the logic even though it cannot run
Xcode.

## Gate 4 — runtime and parity evidence

Not automated, because it depends on what the app does:

1. Install and launch the built product (`xcrun simctl install booted <app>` on
   a simulator, or `open` for a macOS app) and confirm it starts.
2. Capture `xcodebuild -showBuildSettings` for the same configuration and check
   the settings that matter to your build are identical (the gate already does
   this for every discovered setting).
3. Run `xcl rea plan` → `collect.sh` → `rea import` → `xcl compat report` on the
   same machine, and record the coverage number with the Xcode version.
4. Archive the JSON report from gate 3 alongside the evidence.

## What these gates do not prove

- On macOS / Xcode 27.1, the HelloXcode fixture **passed 132
  regression tests**, compiled and packaged the real simulator app, passed
  code-signing/arm64 verification, and matched project structure. The latest
  real hardware settings gate still failed: **zero value mismatches and
  15 missing settings** across two targets (7 app, 8 XCTest).
- The newest Mac report identifies ENTITLEMENTS_ALLOWED and
  PROVISIONING_PROFILE_REQUIRED_YES_YES as missing from the HelloXcode
  APPLICATION, not the hosted XCTest target. Their Xcode-27.1 simulator
  defaults and post-resolution fallback are now correctly scoped to the app;
  XCTest remains unaffected and higher-priority overrides retain precedence.
  This correction passes regressions but has NOT yet been measured on macOS;
  the latest hardware checkpoint is 0/15. The current **134/134 Node regressions pass** in
  isolated validation. The remaining missing entries include SDK stat-cache
  and compilation-cache paths, Xcode-injected PATH, Swift protocol metadata,
  conditional runpaths, and Xcode-private internal state. Do not synthesize
  these without authoritative runtime evidence, or suppress them to bypass
  the strict release gate. Complete raw evidence stays local.
- Missing settings now include their Xcode reference values in the detailed
  JSON report. The complete artifact can contain local paths and identities;
  review it before sharing or committing.
- One successful build does not imply compatibility for every product type,
  configuration or SDK. Treat each new project shape as unverified until it
  passes gate 3.
- Test *execution*, Swift Package resolution, archives/export and notarization
  are out of scope; see [COMPATIBILITY.md](COMPATIBILITY.md#known-divergences).

A release claim should name the Xcode version, the project used for gate 3, and
the compatibility report produced in gate 4. Without those three, "compatible"
is a hypothesis, not a result.

- After that Mac checkpoint, the resolver now derives selected non-opaque SDK/platform conditional selector values (`__IS_NOT_MACOS`, `__IS_NOT_SIMULATOR`, and related selectors) and the original iOS LLVM triple system, based on public Xcode build-output evidence. The resulting 130/130 isolated tests pass. `__ARCHS__` and generated/private state remain intentionally unresolved, and no new Mac result is claimed.

- Latest post-Mac diagnostics now include the exact conditional linker-selector references (`LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_*`, `PRODUCT_SPECIFIC_LDFLAGS*`, and `PRODUCT_TYPE_SWIFT_STDLIB_TOOL_FLAGS_NO_XCTEST_NO`), with absolute paths redacted. The comparator is unchanged; reference values are **not** silently installed as defaults. The full isolated regression suite passes 131/131. Mac effect remains unmeasured.

- After the latest real 0/15 Mac checkpoint, six conditional product linker values were reconstructed from the Mac certifier's redacted **reference values**, scoped to Xcode 27.1 iOS Simulator application or hosted XCTest targets: `LD_RUNPATH_SEARCH_PATHS_YES`, `LD_RUNPATH_SEARCH_PATHS_SHALLOW_BUNDLE_NO/YES`, `PRODUCT_SPECIFIC_LDFLAGS`, `PRODUCT_SPECIFIC_LDFLAGS_NO_XCTEST_NO`, and `PRODUCT_TYPE_SWIFT_STDLIB_TOOL_FLAGS_NO_XCTEST_NO`. An added test protects product, version and explicit-override precedence; the isolated regression suite passes 132/132. The post-change Mac effect is not yet measured. Do not claim those six are certified until `certify:mac` passes.

- After the 0/15 Mac result, additional privacy-safe SDKStatCaches and generated test-entry path **shape** diagnostics were added and pass 133/133 Node regressions. No reference values were copied into the implementation; no Mac measurement of these diagnostic changes yet. Remaining dynamic caches, Swift metadata, toolchain PATH, and opaque internal state remain unresolved. Do not release until all strict gates pass.

- After the latest genuine Mac 0/15 result (133/133 tests), `COMPILATION_CACHE_CAS_PATH` is now derived from the selected `-derivedDataPath` root and `CompilationCache.noindex` for project-scoped explicit DerivedData builds; no fixed user paths. Regression tests cover independent DerivedData roots and command-line override precedence. The reconstructed branch passes 134/134 Node tests. **This CAS path has not yet been measured on Mac**, and its correctness must be confirmed by strict parity; do not assume the two missing occurrences are resolved. `SDK_STAT_CACHE_PATH`, generated XCTest entry, PATH, Swift constant protocols and private build identifiers remain unimplemented pending exact evidence.

- **2026-10-21 latest Mac hardware result:** 134/134 tests, project structure, simulator compilation and signed arm64 PASS; settings parity failed with **2 differing values and 13 missing occurrences**. Both differences were `COMPILATION_CACHE_CAS_PATH`, proving the prior derived-data-based CAS derivation wrong. Post-run source fix uses the discovered versioned per-user `CACHE_ROOT` and fails closed when absent. Full isolated regressions remain 134/134, but the corrected CAS location is **not yet Mac-certified**. Do not ignore these differences or release until exact parity passes.

- Latest genuine Mac run: 134 tests passed, simulator build and signed arm64 bundle passed, and setting comparison found zero different values and 13 missing occurrences. Subsequent privacy-safe diagnostics have 135 passing Node regressions but are not Mac-certified; the strict parity gate remains incomplete.

- Latest Mac certification ran 135/135 tests and verified actual signed arm64 simulator build, with zero different settings and 13 missing occurrences. New follow-up derives `__ARCHS__` from the final resolved architecture set on Xcode 27.1 iOS Simulator only, preserving SDK and explicit overrides. Safe missing-field diagnostics now include affected target names for conditional keys such as `AGGREGATE_TRACKED_DOMAINS`. The 136/136 isolated regression suite passes; the changes are not Mac-certified. Strict parity gate remains in effect; remaining private hashes/serialized state must not be synthesized.
