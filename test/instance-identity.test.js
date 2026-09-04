"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadIdentity, shortId, FILE_NAME } = require("../lib/instance-identity");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-identity-"));
}

test("an instance keeps the same id across restarts", () => {
  const dataHome = tmpHome();
  const first = loadIdentity({ dataHome, name: "ahsan" });
  const second = loadIdentity({ dataHome, name: "ahsan" });

  assert.equal(second.id, first.id, "a colleague's CLI must still reach it after a reboot");
  assert.equal(second.name, "ahsan");
  assert.ok(fs.existsSync(path.join(dataHome, FILE_NAME)));
});

test("a renamed host keeps its id, so existing refs still resolve", () => {
  const dataHome = tmpHome();
  const before = loadIdentity({ dataHome, name: "old-name" });
  const after = loadIdentity({ dataHome, name: "new-name" });

  assert.equal(after.id, before.id);
  assert.equal(after.name, "new-name");
});

test("a corrupt identity file is replaced rather than crashing the server", () => {
  const dataHome = tmpHome();
  fs.writeFileSync(path.join(dataHome, FILE_NAME), "{ this is not json");

  const identity = loadIdentity({ dataHome, name: "ahsan" });
  assert.match(identity.id, /^[0-9a-f-]{36}$/);
  assert.equal(identity.persisted, true);
});

test("an unwritable data dir still yields a usable identity", () => {
  // An instance that could not persist its id is fully usable locally; it just
  // loses remote addressability next boot. Refusing to start would be worse.
  const identity = loadIdentity({
    dataHome: path.join("/proc", "definitely-not-writable-prsnooze"),
    name: "ahsan",
  });

  assert.match(identity.id, /^[0-9a-f-]{36}$/);
  assert.equal(identity.persisted, false);
});

test("a ref's instance handle is short, stable and typeable", () => {
  assert.equal(shortId("01a06b8a-ea9a-7432-9b57-42a1c1563282"), "01a06b8a");
  assert.equal(shortId(shortId("01a06b8a-ea9a-7432-9b57-42a1c1563282")), "01a06b8a");
  assert.equal(shortId(null), "");
});
