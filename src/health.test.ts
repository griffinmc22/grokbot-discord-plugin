import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createHealthMonitor,
  healthFileContents,
  installProcessHandlers,
  loadHealthConfig,
  writeFileAtomic,
  type HealthConfig,
} from "./health.ts";

const config: HealthConfig = {
  intervalMs: 30_000,
  maxUnhealthyMs: 120_000,
  pingGraceMs: 60_000,
  maxPingMs: 10_000,
  restIntervalMs: 300_000,
  restMaxFailures: 3,
  restTimeoutMs: 50,
  healthFile: "/tmp/.health",
  debug: false,
};

function harness(overrides: Partial<HealthConfig> = {}) {
  const state = { now: 1_000_000, ready: false, ping: -1, rest: "ok" as "ok" | "fail" | "hang" };
  const writes: { path: string; contents: string }[] = [];
  const exits: number[] = [];
  const lines: string[] = [];
  const monitor = createHealthMonitor(
    { ...config, ...overrides },
    {
      now: () => state.now,
      isReady: () => state.ready,
      statusLabel: () => (state.ready ? "Ready" : "Reconnecting"),
      ping: () => state.ping,
      writeHealthFile: (path, contents) => writes.push({ path, contents }),
      restCheck: () =>
        state.rest === "ok"
          ? Promise.resolve({ id: "bot" })
          : state.rest === "hang"
            ? new Promise(() => undefined)
            : Promise.reject(new Error("503 Service Unavailable")),
      exit: (code) => exits.push(code),
      log: (line) => lines.push(line),
    },
  );
  const advance = (ms: number) => {
    state.now += ms;
    return monitor.tick();
  };
  return { state, writes, exits, lines, monitor, advance };
}

describe("health monitor", () => {
  it("writes the health file with epoch ms and ISO time when Ready with a sane ping", () => {
    const h = harness();
    h.state.ready = true;
    h.state.ping = 42;

    assert.equal(h.advance(30_000).state, "healthy");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.path, "/tmp/.health");
    assert.equal(h.writes[0]?.contents, healthFileContents(1_030_000));
    assert.match(h.writes[0]?.contents ?? "", /^1030000 1970-01-01T00:17:10\.000Z\n$/);
    assert.deepEqual(h.exits, []);
  });

  it("treats ping -1 as sane only for the first 60s after Ready", () => {
    const h = harness();
    h.state.ready = true;
    h.state.ping = -1;

    assert.equal(h.advance(1_000).state, "healthy"); // Ready seen now
    assert.equal(h.advance(59_000).state, "healthy"); // 59s after Ready
    assert.equal(h.advance(2_000).state, "unhealthy"); // 61s, still no heartbeat ack
    h.state.ping = 55;
    assert.equal(h.advance(1_000).state, "healthy");
  });

  it("rejects an insane ping", () => {
    const h = harness();
    h.state.ready = true;
    h.state.ping = 15_000;
    const tick = h.advance(30_000);
    assert.equal(tick.state, "unhealthy");
    assert.match(tick.reason ?? "", /ping 15000ms/);
    h.state.ping = Number.POSITIVE_INFINITY;
    assert.equal(h.advance(1).state, "unhealthy");
  });

  it("exits 1 when not Ready continuously for more than the threshold, logging once plus the exit line", () => {
    const h = harness();
    h.state.ready = true;
    h.state.ping = 40;
    h.advance(30_000);
    h.state.ready = false;

    assert.equal(h.advance(30_000).state, "unhealthy");
    assert.equal(h.advance(60_000).state, "unhealthy");
    assert.equal(h.advance(60_000).state, "unhealthy"); // exactly 120s: not yet
    assert.deepEqual(h.exits, []);
    assert.equal(h.advance(1).state, "exiting");
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.lines.filter((line) => /unhealthy \(status Reconnecting\)/.test(line)).length, 1);
    assert.match(h.lines.at(-1) ?? "", /unhealthy for 120001ms .*exiting with code 1/);

    // No double exit.
    assert.equal(h.advance(60_000).state, "exiting");
    assert.deepEqual(h.exits, [1]);
  });

  it("exits if the gateway never becomes Ready after start", () => {
    const h = harness();
    h.advance(120_000);
    assert.deepEqual(h.exits, []);
    h.advance(1);
    assert.deepEqual(h.exits, [1]);
  });

  it("recovery before the threshold resets the unhealthy clock", () => {
    const h = harness();
    h.state.ready = true;
    h.state.ping = 40;
    h.advance(1_000);

    h.state.ready = false;
    h.advance(100_000);
    h.state.ready = true;
    assert.equal(h.advance(10_000).state, "healthy");
    assert.ok(h.lines.some((line) => /recovered after/.test(line)));

    h.state.ready = false;
    h.advance(100_000);
    h.advance(19_000); // 119s into the second outage, 229s total
    assert.deepEqual(h.exits, []);
  });

  it("logs a failing health-file write once and keeps running", () => {
    const lines: string[] = [];
    const monitor = createHealthMonitor(config, {
      now: () => 5,
      isReady: () => true,
      statusLabel: () => "Ready",
      ping: () => 10,
      writeHealthFile: () => {
        throw new Error("EACCES: permission denied");
      },
      restCheck: async () => undefined,
      exit: () => assert.fail("must not exit"),
      log: (line) => lines.push(line),
    });

    assert.equal(monitor.tick().state, "healthy");
    assert.equal(monitor.tick().state, "healthy");
    assert.equal(lines.filter((line) => /cannot write health file: EACCES/.test(line)).length, 1);
  });
});

describe("REST liveness check", () => {
  it("counts consecutive failures, resets on success, and exits after 3 in a row", async () => {
    const h = harness();
    h.state.rest = "fail";
    assert.equal(await h.monitor.restTick(), 1);
    assert.equal(await h.monitor.restTick(), 2);
    h.state.rest = "ok";
    assert.equal(await h.monitor.restTick(), 0);
    assert.ok(h.lines.some((line) => /REST liveness check ok after 2 failure/.test(line)));

    h.state.rest = "fail";
    await h.monitor.restTick();
    await h.monitor.restTick();
    assert.deepEqual(h.exits, []);
    await h.monitor.restTick();
    assert.deepEqual(h.exits, [1]);
    assert.ok(h.lines.some((line) => /REST liveness check failed \(3\/3\): 503 Service Unavailable/.test(line)));
  });

  it("counts a hanging REST call as a failure after the timeout", async () => {
    const h = harness();
    h.state.rest = "hang";
    assert.equal(await h.monitor.restTick(), 1);
    assert.ok(h.lines.some((line) => /timed out after 50ms/.test(line)));
  });

  it("start/stop manage unref'd timers without keeping the process alive", () => {
    const h = harness({ intervalMs: 1_000, restIntervalMs: 1_000 });
    h.monitor.start();
    h.monitor.start(); // idempotent
    h.monitor.stop();
    h.monitor.stop();
  });
});

describe("loadHealthConfig", () => {
  it("uses defaults and the repo .health file", () => {
    const loaded = loadHealthConfig({}, "/repo");
    assert.equal(loaded.intervalMs, 30_000);
    assert.equal(loaded.maxUnhealthyMs, 120_000);
    assert.equal(loaded.restIntervalMs, 300_000);
    assert.equal(loaded.healthFile, join("/repo", ".health"));
    assert.equal(loaded.debug, false);
  });

  it("parses overrides, DISCORD_DEBUG, and ignores placeholders", () => {
    const loaded = loadHealthConfig(
      {
        HEALTH_INTERVAL_MS: "5000",
        HEALTH_MAX_UNHEALTHY_MS: "60000",
        HEALTH_REST_INTERVAL_MS: "${HEALTH_REST_INTERVAL_MS}",
        DISCORD_HEALTH_FILE: "/var/run/grok/.health",
        DISCORD_DEBUG: "true",
      },
      "/repo",
    );
    assert.equal(loaded.intervalMs, 5_000);
    assert.equal(loaded.maxUnhealthyMs, 60_000);
    assert.equal(loaded.restIntervalMs, 300_000);
    assert.equal(loaded.healthFile, "/var/run/grok/.health");
    assert.equal(loaded.debug, true);
  });

  it("rejects bad values", () => {
    assert.throws(() => loadHealthConfig({ HEALTH_INTERVAL_MS: "fast" }, "/r"), /HEALTH_INTERVAL_MS/);
    assert.throws(() => loadHealthConfig({ HEALTH_INTERVAL_MS: "10" }, "/r"), /HEALTH_INTERVAL_MS must be a number >= 1000/);
    assert.throws(
      () => loadHealthConfig({ HEALTH_INTERVAL_MS: "60000", HEALTH_MAX_UNHEALTHY_MS: "30000" }, "/r"),
      /at least HEALTH_INTERVAL_MS/,
    );
    assert.throws(() => loadHealthConfig({ DISCORD_DEBUG: "loud" }, "/r"), /DISCORD_DEBUG/);
  });
});

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-health-"));
    try {
      const path = join(dir, "nested", ".health");
      writeFileAtomic(path, "1 a\n");
      writeFileAtomic(path, "2 b\n");
      assert.equal(readFileSync(path, "utf8"), "2 b\n");
      assert.deepEqual(readdirSync(join(dir, "nested")), [".health"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installProcessHandlers", () => {
  function setup(shutdown: () => unknown = async () => undefined) {
    const proc = new EventEmitter();
    const exits: number[] = [];
    const lines: string[] = [];
    let shutdowns = 0;
    installProcessHandlers(proc as never, {
      shutdown: () => {
        shutdowns += 1;
        return shutdown();
      },
      exit: (code) => exits.push(code),
      log: (line) => lines.push(line),
      shutdownTimeoutMs: 30,
    });
    return { proc, exits, lines, shutdowns: () => shutdowns };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it("logs and exits 1 on unhandled rejections and uncaught exceptions", async () => {
    const a = setup();
    a.proc.emit("unhandledRejection", new Error("boom"));
    await settle();
    assert.deepEqual(a.exits, [1]);
    assert.match(a.lines[0] ?? "", /fatal: unhandled rejection: Error: boom/);

    const b = setup();
    b.proc.emit("uncaughtException", new TypeError("bad"));
    await settle();
    assert.deepEqual(b.exits, [1]);
    assert.match(b.lines[0] ?? "", /fatal: uncaught exception: TypeError: bad/);
  });

  it("shuts down and exits 0 on SIGTERM/SIGINT, only once", async () => {
    const t = setup();
    t.proc.emit("SIGTERM");
    t.proc.emit("SIGINT");
    await settle();
    assert.deepEqual(t.exits, [0]);
    assert.equal(t.shutdowns(), 1);
  });

  it("still exits when shutdown hangs or throws", async () => {
    const hang = setup(() => new Promise(() => undefined));
    hang.proc.emit("SIGTERM");
    await settle();
    assert.deepEqual(hang.exits, [0]);

    const fail = setup(async () => {
      throw new Error("destroy failed");
    });
    fail.proc.emit("SIGINT");
    await settle();
    assert.deepEqual(fail.exits, [0]);
    assert.ok(fail.lines.some((line) => /shutdown error: Error: destroy failed/.test(line)));
  });
});
