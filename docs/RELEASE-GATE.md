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

- On macOS 27.0.1 / Xcode 27.1, the HelloXcode fixture **passed 104
  regression tests**, compiled, packaged, passed code-signing/arm64
  verification, and matched project structure. The last measured settings
  gate still failed: **45 differing values and 199 missing occurrences
  across two targets**.
- Subsequent changes read Xcode platform bundle `Info.plist`
  `DefaultProperties` as a lower-priority contextual layer and discover
  SDK/platform build identifiers only when installed Apple metadata provides
  them. The expanded **107/107 Node regressions pass in isolated validation**.
  These improvements have NOT been measured by another genuine Mac run.
  No private Xcode cache or signing setting is fabricated to satisfy parity.
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
