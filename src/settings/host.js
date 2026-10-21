import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

/**
 * Xcode publishes owner and group defaults from the local build account.
 * Resolve them from the host, not a hardcoded username or project fixture.
 */
export function hostAccountSettings({
  env = process.env,
  platform = process.platform,
  getUserInfo = userInfo,
  getGroup = null,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  gid = typeof process.getgid === "function" ? process.getgid() : null,
} = {}) {
  let account = {};
  try { account = getUserInfo() ?? {}; } catch { /* sandbox may hide user records */ }
  const username = account.username || env.USER || env.LOGNAME || "";
  const home = account.homedir || env.HOME || homedir();
  let group = env.GROUP || "";
  if (getGroup) {
    group = getGroup();
  } else if (platform === "darwin") {
    try {
      group = execFileSync("id", ["-gn"], {
        encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Missing group metadata should never block a Swift build.
    }
  }
  const settings = {};
  if (username) {
    settings.ALTERNATE_OWNER = username;
    settings.INSTALL_OWNER = username;
    settings.USER = username;
  }
  if (group) {
    settings.ALTERNATE_GROUP = group;
    settings.INSTALL_GROUP = group;
    settings.GROUP = group;
  }
  if (home) settings.HOME = home;
  if (uid !== null && Number.isInteger(uid)) settings.UID = String(uid);
  if (gid !== null && Number.isInteger(gid)) settings.GID = String(gid);
  return settings;
}
