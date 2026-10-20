# Verification reports

`scripts/macos-verify.mjs --json docs/verification/<name>.json` writes its report
here. One file per project, configuration, SDK and Xcode version.

A report is evidence, so it records what was actually run:

- the Xcode version and build from `xcodebuild -version`
- the absolute project path, scheme, configuration and SDK
- each gate's status, and for the settings gate the number of settings compared,
  differing and missing
- for the build gate, the product paths found on disk

Commit reports from machines you trust. Do not hand-edit them: a report with a
tidied mismatch is worse than no report.

Until at least one report exists in this directory, every "Verified" column in
the root README should be read as "not yet verified on hardware", no matter what
the code does.

## Local discrepancy summary

On the Mac that generated a comparison report, run:

```bash
node scripts/settings-summary.mjs docs/verification/settings-after-precedence.json --limit 20
```

This reads the existing JSON report without rerunning Xcode or rebuilding the
product. It groups every missing and differing setting by subsystem, reports
occurrences and unique keys across targets, and prints **setting names only**.
It does not print local paths, signing identities, usernames, or actual setting
values. The raw JSON may still contain these values; review it before sharing.
Reports generated before full structured differences were added cannot be
summarized by this command.
