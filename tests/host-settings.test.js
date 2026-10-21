import test from "node:test";
import assert from "node:assert/strict";
import { hostAccountSettings } from "../src/settings/host.js";

test("host account settings use discovered owner and group, not fixed identities", () => {
  const result = hostAccountSettings({
    platform: "darwin",
    env: { GROUP: "ignored", HOME: "/home/incorrect" },
    getUserInfo: () => ({ username: "test-builder", homedir: "/Users/test-builder" }),
    getGroup: () => "staff-test",
    uid: 501,
    gid: 20,
  });
  assert.deepEqual(result, {
    ALTERNATE_OWNER: "test-builder",
    INSTALL_OWNER: "test-builder",
    USER: "test-builder",
    ALTERNATE_GROUP: "staff-test",
    INSTALL_GROUP: "staff-test",
    GROUP: "staff-test",
    HOME: "/Users/test-builder",
    UID: "501",
    GID: "20",
  });
});
test("missing user metadata does not prevent build settings resolution", () => {
  const settings = hostAccountSettings({
    platform: "linux",
    env: {},
    getUserInfo: () => { throw new Error("missing user database"); },
    uid: null,
    gid: null,
  });
  assert.equal(settings.ALTERNATE_OWNER, undefined);
  assert.equal(settings.UID, undefined);
});
