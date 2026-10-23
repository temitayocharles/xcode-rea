import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { detectToolchain } from "../settings/toolchain.js";
import { buildReaPlan, renderCollectScript, renderReaReadme } from "./plan.js";
import { extractEvidence, mergeEvidence, expandEvidenceInputs } from "./import.js";
import { UsageError } from "../cli/parser.js";

function writeOut(text) {
  process.stdout.write(text);
}

function writeErr(text) {
  process.stderr.write(text);
}

function planCommand(parsed) {
  const toolchain = detectToolchain();
  const xcodeApp = parsed.get("xcode")
    ? resolve(parsed.get("xcode"))
    : toolchain.xcodeApp ?? "/Applications/Xcode.app";
  const outDir = resolve(parsed.get("out") ?? "evidence/rea");
  const provider = parsed.get("provider") ?? "ghidra";
  const plan = buildReaPlan({ xcodeApp, outDir, provider });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(outDir, "collect.sh"), renderCollectScript(plan), { mode: 0o755 });
  writeFileSync(join(outDir, "README.md"), renderReaReadme(plan));

  const phases = new Map();
  for (const command of plan.commands) phases.set(command.phase, (phases.get(command.phase) ?? 0) + 1);

  writeOut(`REA evidence plan for ${xcodeApp}\n`);
  writeOut(`  components: ${plan.components.length}\n`);
  for (const [phase, count] of [...phases].sort()) {
    writeOut(`  phase ${phase}: ${count} commands\n`);
  }
  writeOut(`\nWrote:\n  ${join(outDir, "plan.json")}\n  ${join(outDir, "collect.sh")}\n  ${join(outDir, "README.md")}\n`);
  const relativeOut = relative(process.cwd(), outDir);
  const displayOut = relativeOut.startsWith("..") ? outDir : relativeOut || ".";
  const runHint = displayOut.startsWith("/") ? `bash ${displayOut}/collect.sh` : `./${displayOut}/collect.sh`;
  writeOut(`\nRun on the Mac:\n  ${runHint}\n\nThen import:\n  xcl rea import ${displayOut}/*.json\n`);
  if (!toolchain.found) {
    writeErr(
      "note: no local Xcode toolchain detected; the plan is still valid and can be run on the target Mac.\n",
    );
  }
  return 0;
}

function importCommand(parsed) {
  const inputs = parsed.positionals.slice(1);
  if (inputs.length === 0) {
    throw new UsageError("usage: xcl rea import FILE|DIR [FILE|DIR ...]");
  }
  const files = expandEvidenceInputs(inputs);
  if (files.length === 0) {
    writeErr(`error: no JSON files found in ${inputs.join(", ")}\n`);
    return 1;
  }
  const incoming = extractEvidence(files);
  const outPath = resolve(parsed.get("out") ?? "compat/evidence.json");
  let existing = null;
  if (existsSync(outPath)) {
    try {
      existing = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      writeErr(`warning: existing ${outPath} is not valid JSON; replacing it\n`);
    }
  }
  const merged = mergeEvidence(existing, incoming);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);

  writeOut(`Imported ${files.length} evidence file(s).\n`);
  writeOut(`  build-setting candidates: ${Object.keys(incoming.buildSettings).length}\n`);
  writeOut(`  class candidates: ${Object.keys(incoming.classes).length}\n`);
  writeOut(`  frameworks: ${incoming.frameworks.length}\n`);
  writeOut(`  libraries: ${incoming.libraries.length}\n`);
  writeOut(`Wrote ${outPath}\n`);
  return 0;
}

function statusCommand(parsed) {
  const path = resolve(parsed.get("out") ?? "compat/evidence.json");
  if (!existsSync(path)) {
    writeOut("No imported REA evidence yet.\n");
    writeOut("Run `xcl rea plan`, then execute the generated collect.sh on the Mac.\n");
    return 0;
  }
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  writeOut(`Evidence: ${path}\n`);
  writeOut(`  generated: ${evidence.generatedAt ?? "unknown"}\n`);
  writeOut(`  sources: ${evidence.sources?.length ?? 0}\n`);
  writeOut(`  build-setting candidates: ${Object.keys(evidence.buildSettings ?? {}).length}\n`);
  writeOut(`  classes: ${Object.keys(evidence.classes ?? {}).length}\n`);
  writeOut(`  frameworks: ${evidence.frameworks?.length ?? 0}\n`);
  writeOut(`  libraries: ${evidence.libraries?.length ?? 0}\n`);
  return 0;
}

function summaryCommand(parsed) {
  const dir = resolve(parsed.get("out") ?? "evidence/rea");
  const planPath = join(dir, "plan.json");
  if (!existsSync(planPath)) {
    writeErr(`error: ${planPath} not found; run \`xcl rea plan\` first\n`);
    return 1;
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const counts = {};
  for (const command of plan.commands) counts[command.component] = (counts[command.component] ?? 0) + 1;
  writeOut(`${plan.commands.length} commands across ${plan.components.length} components:\n`);
  for (const component of plan.components) {
    writeOut(`  ${component.id} (${counts[component.id] ?? 0}) — ${component.role}\n`);
  }
  return 0;
}

function windowsCommand() {
  writeOut("To find Xcode's window ID (macOS):\n");
  writeOut("  1. Launch Xcode and open a project.\n");
  writeOut("  2. Run: osascript -e 'tell application \"System Events\" to get name of windows of process \"Xcode\"'\n");
  writeOut("  3. REA's observe-native-ui also reports the exact window ID in its result.\n");
  writeOut("Then: XCODE_WINDOW_ID=<id> ./evidence/rea/collect.sh\n");
  return 0;
}

export function runReaCommand(parsed) {
  const action = parsed.positionals[0] ?? "status";
  switch (action) {
    case "plan":
      return planCommand(parsed);
    case "import":
      return importCommand(parsed);
    case "status":
      return statusCommand(parsed);
    case "summary":
      return summaryCommand(parsed);
    case "windows":
      return windowsCommand();
    default:
      throw new UsageError(`unknown rea action: ${action} (try plan, import, status, summary)`);
  }
}
