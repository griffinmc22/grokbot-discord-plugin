import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { acquireGatewayLock } from "./gateway-lock.ts";

describe("gateway lock", () => {
  let dir = "";
  let path = "";
  let now = 1_000_000;
  const alive = new Set<number>();
  const options = (pid: number) => ({
    path,
    pid,
    now: () => now,
    isAlive: (candidate: number) => alive.has(candidate),
    staleMs: 180_000,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grok-lock-"));
    path = join(dir, "runtime", "gateway-abc.lock");
    now = 1_000_000;
    alive.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets one gateway hold the lock and refuses a second live one", () => {
    alive.add(100).add(200);
    const first = acquireGatewayLock(options(100));
    assert.equal(first.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pid: 100, updatedAt: now });

    now += 10_000;
    const second = acquireGatewayLock(options(200));
    assert.deepEqual(second, { ok: false, holderPid: 100, ageMs: 10_000 });
  });

  it("a gateway that exits (watchdog exit 1 included) releases the lock so the restart can start", () => {
    alive.add(100).add(200);
    const first = acquireGatewayLock(options(100));
    assert.ok(first.ok);
    // What the process 'exit' handler does on process.exit(1).
    first.lock.release();
    first.lock.release();
    assert.equal(existsSync(path), false);

    alive.delete(100);
    const restarted = acquireGatewayLock(options(200));
    assert.equal(restarted.ok, true);
  });

  it("reclaims a lock left by a dead (SIGKILLed) gateway", () => {
    alive.add(200);
    const ghost = acquireGatewayLock(options(100));
    assert.ok(ghost.ok);
    // pid 100 is not alive and never released.
    const next = acquireGatewayLock(options(200));
    assert.ok(next.ok);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 200);
  });

  it("reclaims a stale lock even if its pid is alive (wedged gateway or reused pid)", () => {
    alive.add(100).add(200);
    const wedged = acquireGatewayLock(options(100));
    assert.ok(wedged.ok);
    now += 180_000;
    const next = acquireGatewayLock(options(200));
    assert.ok(next.ok);

    // The wedged holder finds out it lost the lock on its next refresh, and doesn't clobber it.
    assert.equal(wedged.lock.refresh(), false);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 200);
    wedged.lock.release();
    assert.equal(existsSync(path), true);
  });

  it("refresh keeps a healthy holder fresh and recreates a deleted lock file", () => {
    alive.add(100).add(200);
    const held = acquireGatewayLock(options(100));
    assert.ok(held.ok);

    now += 170_000;
    assert.equal(held.lock.refresh(), true);
    now += 170_000;
    assert.equal(acquireGatewayLock(options(200)).ok, false);

    unlinkSync(path);
    assert.equal(held.lock.refresh(), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 100);
  });

  it("treats a corrupt lock file as stale", () => {
    alive.add(200);
    acquireGatewayLock(options(999)); // creates dirs
    writeFileSync(path, "not json");
    assert.equal(acquireGatewayLock(options(200)).ok, true);
  });
});
