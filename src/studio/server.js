import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProjects, platformFromSdkName } from "../cli/context.js";
import { detectToolchain, resolveSdk } from "../settings/toolchain.js";
import { defaultDerivedDataPath } from "../settings/defaults.js";
import { resolveBuildSettings } from "../settings/resolver.js";
import { planTarget, expandPath } from "../build/plan.js";
import { sortObjectByKey } from "../util/output.js";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function defaultPlatform(project) {
  for (const config of project.projectConfigurations().configurations) {
    const sdkroot = config.buildSettings?.SDKROOT;
    if (sdkroot) {
      const platform = platformFromSdkName(sdkroot);
      if (platform) return platform;
    }
  }
  return "macosx";
}

function defaultArch() {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

function relativeToProject(project, path) {
  if (!path) return "";
  const prefix = `${project.projectDir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function projectPayload(project, toolchain) {
  return {
    name: project.name,
    path: project.path,
    projectDir: project.projectDir,
    objectVersion: project.objectVersion,
    compatibilityVersion: project.compatibilityVersion ?? null,
    configurations: project.configurationNames(),
    defaultConfiguration: project.defaultConfigurationName(),
    defaultPlatform: defaultPlatform(project),
    defaultArch: defaultArch(),
    schemes: [],
    toolchain: {
      found: toolchain.found,
      developerDir: toolchain.developerDir,
      version: toolchain.version,
      isCommandLineTools: toolchain.isCommandLineTools,
    },
    targets: project.targets().map((target) => {
      const productInfo = target.productType ?? "";
      return {
        id: target.id,
        name: target.name,
        productType: productInfo,
        productKind: productKindLabel(productInfo),
        productPath: project.productPath(target.id),
        sources: project.sources(target.id).map((entry) => ({
          path: relativeToProject(project, entry.path),
          origin: entry.origin,
        })),
        resources: project.resources(target.id).map((entry) => ({
          path: relativeToProject(project, entry.path),
          kind: entry.kind,
          origin: entry.origin,
        })),
        dependencies: project.dependencies(target.id).map((entry) => entry.name),
      };
    }),
  };
}

function productKindLabel(productType) {
  if (!productType) return "unknown";
  if (productType.includes("unit-test") || productType.includes("ui-testing")) return "test bundle";
  if (productType.includes("app-extension")) return "app extension";
  if (productType.includes("framework")) return "framework";
  if (productType.includes("static")) return "static library";
  if (productType.includes("application")) return "application";
  if (productType.includes("tool")) return "command-line tool";
  return productType.replace("com.apple.product-type.", "");
}

function selectProjectAndTarget(projects, query) {
  const projectName = query.get("project");
  const project = projects.find((entry) => entry.name === projectName) ?? projects[0];
  const targetName = query.get("target");
  const target = targetName
    ? project.targetByName(targetName)
    : project.targets()[0];
  return { project, target };
}

export async function runStudioCommand(parsed) {
  const context = loadProjects(parsed);
  const toolchain = detectToolchain();
  const port = Number(parsed.get("port") ?? process.env.PORT ?? 4173);
  const host = parsed.get("host") ?? "0.0.0.0";

  const resolveSelection = (query) => {
    const { project, target } = selectProjectAndTarget(context.projects, query);
    if (!target) {
      throw new Error(`project ${project.name} has no targets`);
    }
    const configuration = query.get("configuration") ?? project.defaultConfigurationName();
    const platform = query.get("platform") ?? defaultPlatform(project);
    const arch = query.get("arch") ?? defaultArch();
    const sdk = resolveSdk({ developerDir: toolchain.developerDir, platform });
    const resolved = resolveBuildSettings({
      project,
      target,
      configuration,
      platform,
      sdk,
      arch,
      hostArch: defaultArch(),
      derivedDataPath: defaultDerivedDataPath(project.path),
      developerDir: toolchain.developerDir,
      overrides: {},
      action: "build",
    });
    const plan = planTarget({
      project,
      target,
      configuration,
      settings: resolved.settings,
      platform,
      arch,
      sdkPath: sdk?.path ?? null,
      deploymentTarget: resolved.settings.DEPLOYMENT_TARGET,
      productType: target.productType,
    });
    return { project, target, configuration, platform, arch, sdk, resolved, plan };
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const json = (status, value) => {
      const body = JSON.stringify(value, null, 2);
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(body);
    };

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
      return;
    }

    if (url.pathname === "/api/health") {
      json(200, { ok: true, version: "0.1.0" });
      return;
    }

    if (url.pathname === "/api/project") {
      const project = context.projects[0];
      json(200, projectPayload(project, toolchain));
      return;
    }

    if (url.pathname === "/api/settings" || url.pathname === "/api/plan") {
      try {
        const selection = resolveSelection(url.searchParams);
        if (url.pathname === "/api/settings") {
          json(200, {
            target: selection.target.name,
            configuration: selection.configuration,
            platform: selection.platform,
            arch: selection.arch,
            sdk: selection.sdk?.name ?? null,
            warnings: selection.resolved.warnings,
            settings: sortObjectByKey(selection.resolved.settings),
          });
          return;
        }
        const { plan } = selection;
        json(200, {
          target: selection.target.name,
          configuration: selection.configuration,
          platform: selection.platform,
          arch: selection.arch,
          triple: plan.triple,
          product: expandPath(
            plan.target.productPath,
            selection.resolved.settings,
          ),
          warnings: plan.warnings,
          steps: plan.steps.map((step) => ({
            kind: step.kind,
            title: step.title,
            display: step.display,
            description: step.description ?? null,
            inputs: step.inputs,
            outputs: step.outputs,
          })),
        });
        return;
      } catch (error) {
        json(400, { error: error.message });
        return;
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(`xcl studio listening on http://${host}:${port}\n`);
  process.stdout.write(`Project: ${context.projects[0].name}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  await new Promise(() => {});
}
