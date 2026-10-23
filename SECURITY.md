# Security and responsible use

## Scope

`xcl` parses untrusted project files and executes build tools. It is intended for
local development and CI on projects you trust or have reviewed.

## What `xcl` does not do

- It does not bypass code signing, DRM, licence checks, or Apple's terms.
- It does not execute an inspected binary as part of REA evidence collection;
  the generated plan uses REA's static inspection commands.
- It does not send project data over the network.
- It does not modify `.xcodeproj`, `.xcworkspace`, `.xcscheme` or `.xcconfig`
  files.
- It does not install anything. `xcl spec sync` writes a JSON file inside your
  repository; `xcl studio` serves read-only views.

## What to watch

1. **Shell script build phases.** A `.pbxproj` can contain arbitrary shell
   scripts. `xcl` includes them in the plan and executes them on `build`. Use
   `--dry-run` first and never build a project you do not trust.
2. **Build settings influence tool invocation.** Settings such as
   `OTHER_LDFLAGS`, `OTHER_SWIFT_FLAGS`, `GCC_PREPROCESSOR_DEFINITIONS` and
   `SWIFT_OBJC_BRIDGING_HEADER` are passed to compilers. They are argv elements,
   not shell-interpreted, but they can still direct the compiler to read or
   write files.
3. **`xcl studio` binds to `0.0.0.0` by default** so it works in containers and
   remote dev environments. It exposes project paths, settings and build
   commands to anyone who can reach the port. Use `--host 127.0.0.1` on shared
   networks, or put it behind your usual auth proxy.
4. **REA evidence files** may contain paths, symbol names and proprietary
   identifiers from Apple binaries. Treat them as confidential to your
   organisation and do not commit them unless your policy allows it.
5. **Derived data.** Builds write only under `-derivedDataPath` (default
   `~/Library/Developer/Xcode/DerivedData`). `xcl clean` removes the products and
   target temp directories for the selected configuration; it does not delete the
   whole DerivedData tree.

## Reporting

Open a private security advisory in the repository, or contact the maintainers
listed in `package.json`. Please include the `xcl version`, the project format
(`objectVersion`), and a minimal reproduction that does not contain confidential
source.
