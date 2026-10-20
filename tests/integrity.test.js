import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository integrity checks.
 *
 * These exist because a build module once passed its tests locally while being
 * absent from the commit: a bare `build/` ignore pattern matched `src/build`,
 * so `git add` silently skipped it. Nothing failed until someone cloned the
 * branch. The checks below fail loudly instead.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const SOURCE_ROOTS = ["src", "bin", "scripts", "tests"];
const SHIPPED_ROOTS = ["src", "bin", "scripts", "tests", "docs"];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function hasGitRepo() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return existsSync(join(root, ".git"));
  } catch {
    return false;
  }
}

test("every relative import resolves to a committed module", () => {
  const modules = SOURCE_ROOTS.flatMap((dir) => walk(join(root, dir)));
  assert.ok(modules.length > 20, `expected to scan the source tree, found ${modules.length} files`);

  const unresolved = [];
  for (const file of modules) {
    const text = readFileSync(file, "utf8");
    const specifiers = [
      ...text.matchAll(/(?:import|export)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g),
      ...text.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    for (const specifier of specifiers) {
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target) || !statSync(target).isFile()) {
        unresolved.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(unresolved, [], `unresolved imports:\n${unresolved.join("\n")}`);
});

test("the modules named by package.json exist", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const target of Object.values(manifest.bin ?? {})) {
    assert.ok(existsSync(join(root, target)), `bin target missing: ${target}`);
  }
  const exported = manifest.exports?.["."];
  if (typeof exported === "string") {
    assert.ok(existsSync(join(root, exported)), `export missing: ${exported}`);
  }
  for (const script of Object.values(manifest.scripts ?? {})) {
    for (const match of script.matchAll(/(?:^|\s)((?:\.\/)?[\w./-]+\.m?js)(?:\s|$)/g)) {
      const candidate = match[1].replace(/^\.\//, "");
      if (candidate.includes("*")) continue;
      assert.ok(existsSync(join(root, candidate)), `script target missing: ${candidate}`);
    }
  }
});

test("no shipped source file is ignored by version control", (t) => {
  if (!hasGitRepo()) {
    t.skip("not a git checkout");
    return;
  }
  const ignored = [];
  for (const dir of SHIPPED_ROOTS) {
    for (const path of walk(join(root, dir))) {
      try {
        git(["check-ignore", "-q", path]);
        ignored.push(relative(root, path));
      } catch {
        // Exit status 1 means "not ignored", which is what we want.
      }
    }
  }
  assert.deepEqual(ignored, [], `source files hidden by ignore rules:\n${ignored.join("\n")}`);
});

test("every shipped file is committed", (t) => {
  if (!hasGitRepo()) {
    t.skip("not a git checkout");
    return;
  }
  const tracked = new Set(
    git(["ls-files", "-z"])
      .split("\0")
      .filter(Boolean),
  );

  const missing = [];
  for (const dir of SHIPPED_ROOTS) {
    for (const path of walk(join(root, dir))) {
      const relativePath = relative(root, path).split("\\").join("/");
      if (!tracked.has(relativePath)) missing.push(relativePath);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `files present in the working tree but absent from the commit:\n${missing.join("\n")}`,
  );
});

test("ignore rules cannot hide any source subtree", (t) => {
  if (!hasGitRepo()) {
    t.skip("not a git checkout");
    return;
  }

  // Ask git directly, using hypothetical paths, so the check keeps working
  // even before a directory has files in it.
  const directories = [];
  const walkDirs = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      directories.push(path);
      walkDirs(path);
    }
  };
  walkDirs(join(root, "src"));

  const shadowed = [];
  for (const dir of directories) {
    const probe = join(dir, "__integrity_probe__.js");
    try {
      git(["check-ignore", "--no-index", "-q", probe]);
      shadowed.push(`${relative(root, dir)}/`);
    } catch {
      // status 1 = not ignored
    }
  }
  assert.deepEqual(
    shadowed,
    [],
    `these source directories are hidden by ignore rules:\n${shadowed.join("\n")}`,
  );

  // And the rule itself should be anchored, so a future src/<ignored-name>
  // cannot be swallowed without anyone noticing.
  const patterns = readFileSync(join(root, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  const unanchored = patterns.filter(
    (pattern) => pattern.endsWith("/") && !pattern.startsWith("/") && pattern !== "node_modules/",
  );
  assert.deepEqual(
    unanchored,
    [],
    `directory ignore rules must be root-anchored (use "/name/"): ${unanchored.join(", ")}`,
  );
});

test("the rendered plan for the fixture project is stable", () => {
  const cli = join(root, "bin/xcl.mjs");
  const project = join(root, "tests/fixtures/HelloXcode/HelloXcode.xcodeproj");
  const output = execFileSync(
    process.execPath,
    [
      cli,
      "-project",
      project,
      "-target",
      "HelloXcode",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "--dry-run",
      "--json",
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const result = JSON.parse(output);
  assert.equal(result.status, "planned");
  assert.equal(result.targets.length, 1);
  const summary = result.targets[0];
  assert.equal(summary.target, "HelloXcode");
  assert.equal(summary.steps, 5);
  assert.deepEqual(summary.counts, {
    mkdir: 1,
    link: 1,
    resource: 1,
    bundle: 1,
    sign: 1,
  });
});
