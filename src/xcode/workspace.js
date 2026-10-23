import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseXml, findElements, textContent } from "../plist/index.js";
import { normalizeSlashes } from "../util/text.js";

export class WorkspaceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

function decodeLocation(location, baseDir) {
  if (!location) return null;
  const colon = location.indexOf(":");
  const kind = colon === -1 ? "group" : location.slice(0, colon);
  const value = colon === -1 ? location : location.slice(colon + 1);
  switch (kind) {
    case "absolute":
      return normalizeSlashes(value);
    case "container":
      return normalizeSlashes(resolve(baseDir, value));
    case "self":
      return normalizeSlashes(baseDir);
    case "group":
    case "developer":
    default:
      return normalizeSlashes(resolve(baseDir, value));
  }
}

class Workspace {
  constructor(path, document, baseDir) {
    this.path = normalizeSlashes(path);
    this.workspaceFile = join(path, "contents.xcworkspacedata");
    this.document = document;
    this.baseDir = baseDir ?? dirname(path);
    this.container = this.findWorkspaceElement(document);
  }

  get name() {
    return basename(this.path).replace(/\.xcworkspace$/, "");
  }

  findWorkspaceElement(document) {
    const nodes = findElements(document, "Workspace");
    if (nodes.length === 0) throw new WorkspaceError(`${this.path} has no <Workspace> element`);
    return nodes[0];
  }

  /** Walk groups and file references; returns every referenced project path. */
  entries() {
    const results = [];
    const walk = (node, directory) => {
      for (const child of node.children ?? []) {
        if (typeof child === "string") continue;
        if (child.name === "FileRef") {
          const location = child.attrs.location ?? "";
          const resolved = decodeLocation(location, directory);
          if (!resolved) continue;
          results.push({
            name: child.attrs.name ?? basename(resolved),
            location,
            path: resolved,
            isProject: /\.xcodeproj$/.test(resolved),
            isWorkspace: /\.xcworkspace$/.test(resolved),
          });
        } else if (child.name === "Group") {
          const location = child.attrs.location ?? "";
          const resolved = decodeLocation(location, directory);
          walk(child, resolved ?? directory);
        }
      }
    };
    walk(this.container, this.baseDir);
    return results;
  }

  projects() {
    return this.entries().filter((entry) => entry.isProject);
  }

  static load(inputPath) {
    const workspacePath = inputPath.endsWith(".xcworkspace")
      ? inputPath
      : dirname(inputPath);
    const workspaceFile = join(workspacePath, "contents.xcworkspacedata");
    let text;
    try {
      text = readFileSync(workspaceFile, "utf8");
    } catch (error) {
      throw new WorkspaceError(`cannot read workspace ${workspaceFile}: ${error.message}`, { cause: error });
    }
    return Workspace.parse(text, workspacePath);
  }

  static parse(text, path) {
    const document = parseXml(text);
    const workspacePath = path.endsWith(".xcworkspace") ? path : dirname(path);
    return new Workspace(workspacePath, document, dirname(workspacePath));
  }
}

/**
 * Locate shared and user schemes for a project or workspace.
 * Xcode looks in `<container>/xcshareddata/xcschemes` and
 * `<container>/xcuserdata/<user>.xcuserdatad/xcschemes`.
 */
export function findSchemes(containerPath) {
  const results = [];
  const sharedDir = resolve(containerPath, "xcshareddata", "xcschemes");
  if (existsSync(sharedDir)) {
    for (const name of readdirSync(sharedDir).sort()) {
      if (name.endsWith(".xcscheme")) {
        results.push({ name: name.slice(0, -".xcscheme".length), path: resolve(sharedDir, name), shared: true });
      }
    }
  }
  const userData = resolve(containerPath, "xcuserdata");
  if (existsSync(userData)) {
    for (const user of readdirSync(userData).sort()) {
      const dir = resolve(userData, user, "xcschemes");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".xcscheme")) continue;
        const schemeName = name.slice(0, -".xcscheme".length);
        if (results.some((entry) => entry.name === schemeName)) continue;
        results.push({ name: schemeName, path: resolve(dir, name), shared: false });
      }
    }
  }
  return results;
}

export { Workspace };

export function workspaceProjects(path) {
  return Workspace.load(path).projects();
}
