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
