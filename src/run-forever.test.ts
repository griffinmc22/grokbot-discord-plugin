import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Exercises bin/run-forever.sh with a stub in place of `node` (NODE_BIN), so no Discord is involved.

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "run-forever.sh");
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const secret = "super-secret-token-value-123";

type Run = { code: number | null; stdout: string; stderr: string };

function runScript(envFile: string, timeoutMs = 30_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [script.replace(/\\/g, "/"), envFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`run-forever did not finish in ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("bin/run-forever.sh", { skip: hasSh ? false : "sh is not available" }, () => {
  let dir = "";
  // Paths handed to sh use forward slashes so they work under Git Bash on Windows too.
  const p = (...parts: string[]) => join(dir, ...parts).replace(/\\/g, "/");

  function stub(name: string, body: string): string {
    const path = p(name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function envFile(name: string, vars: Record<string, string>): string {
    const path = p(name);
    const lines = Object.entries(vars).map(([key, value]) => `${key}='${value}'`);
    writeFileSync(path, `${[`DISCORD_TOKEN='${secret}'`, ...lines].join("\n")}\n`);
    return path;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "run-forever-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restarts the gateway on every exit with doubling backoff and never prints env values", async () => {
    const log = p("restart.log");
    const node = stub("node-exit", `echo "start $*" >> "${log}"\nexit 7`);
    const result = await runScript(
      envFile("restart.env", {
        NODE_BIN: node,
        SUPERVISOR_PIDFILE: p("restart.pid"),
        DISCORD_HEALTH_FILE: p("restart.health"),
        RESTART_BACKOFF_MIN_SECONDS: "1",
        RUN_FOREVER_MAX_STARTS: "3",
      }),
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    const starts = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(starts.length, 3);
    assert.match(starts[0] ?? "", /dist\/cli\.js gateway$/);
    assert.match(result.stdout, /gateway exited \(code 7\) after \d+s; restarting in 1s/);
    assert.match(result.stdout, /gateway exited \(code 7\) after \d+s; restarting in 2s/);
    assert.match(result.stdout, /reached RUN_FOREVER_MAX_STARTS=3, stopping/);
    assert.match(result.stdout, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ run-forever: /m);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    assert.equal(existsSync(p("restart.pid")), false, "pidfile is removed on exit");
  });

  it("kills a gateway whose health file goes stale, then restarts it", async () => {
    const log = p("stale.log");
    const node = stub(
      "node-hang",
      `echo start >> "${log}"\ntrap 'echo terminated >> "${log}"; exit 0' TERM\nwhile :; do sleep 1; done`,
    );
    const result = await runScript(
      envFile("stale.env", {
        NODE_BIN: node,
        SUPERVISOR_PIDFILE: p("stale.pid"),
        DISCORD_HEALTH_FILE: p("stale.health"),
        HEALTH_STARTUP_GRACE_SECONDS: "1",
        HEALTH_STALE_SECONDS: "1",
        HEALTH_CHECK_INTERVAL_SECONDS: "1",
        RESTART_BACKOFF_MIN_SECONDS: "1",
        KILL_WAIT_SECONDS: "5",
        RUN_FOREVER_MAX_STARTS: "2",
      }),
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["start", "terminated", "start", "terminated"]);
    assert.match(result.stdout, /health file .*stale\.health is stale \(\d+s > 1s\); killing gateway pid \d+/);
    assert.match(result.stdout, /gateway exited \(code 0\) after \d+s; restarting in 1s/);
  });

  it("leaves a gateway alone while it keeps the health file fresh", async () => {
    const log = p("fresh.log");
    const health = p("fresh.health");
    const node = stub(
      "node-healthy",
      `echo start >> "${log}"\ntrap 'echo terminated >> "${log}"; exit 0' TERM\n` +
        `i=0\nwhile [ "$i" -lt 4 ]; do printf '%s000 now\\n' "$(date +%s)" > "${health}"; sleep 1; i=$((i + 1)); done\nexit 0`,
    );
    const result = await runScript(
      envFile("fresh.env", {
        NODE_BIN: node,
        SUPERVISOR_PIDFILE: p("fresh.pid"),
        DISCORD_HEALTH_FILE: health,
        HEALTH_STARTUP_GRACE_SECONDS: "1",
        HEALTH_STALE_SECONDS: "2",
        HEALTH_CHECK_INTERVAL_SECONDS: "1",
        RUN_FOREVER_MAX_STARTS: "1",
      }),
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["start"]);
    assert.doesNotMatch(result.stdout, /is stale|killing gateway/);
  });

  it("refuses to start while another live supervisor holds the pidfile, and replaces a stale one", async () => {
    const pidfile = p("busy.pid");
    // A live sh process stands in for the other supervisor; $$ is its pid as sh sees it.
    const holder = spawn("sh", ["-c", `echo $$ > "${pidfile}"; exec sleep 30`], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && !existsSync(pidfile); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const node = stub("node-never", `echo "should not run" >&2\nexit 1`);
      const refused = await runScript(envFile("busy.env", { NODE_BIN: node, SUPERVISOR_PIDFILE: pidfile }));

      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /another supervisor is running \(pid \d+, pidfile .*busy\.pid\); refusing to start/);
      assert.doesNotMatch(refused.stderr, /should not run/);
    } finally {
      holder.kill("SIGKILL");
    }

    writeFileSync(pidfile, "999999\n");
    const node = stub("node-once", "exit 0");
    const replaced = await runScript(
      envFile("stalepid.env", { NODE_BIN: node, SUPERVISOR_PIDFILE: pidfile, RUN_FOREVER_MAX_STARTS: "1" }),
    );
    assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
    assert.match(replaced.stdout, /removing stale pidfile/);
    assert.equal(existsSync(pidfile), false);
  });

  it("on SIGTERM stops the gateway, removes its pidfile, and exits 0", async () => {
    const log = p("sigterm.log");
    const pidfile = p("sigterm.pid");
    const node = stub(
      "node-wait",
      `echo start >> "${log}"\ntrap 'echo terminated >> "${log}"; exit 0' TERM\nwhile :; do sleep 1; done`,
    );
    const env = envFile("sigterm.env", { NODE_BIN: node, SUPERVISOR_PIDFILE: pidfile, HEALTH_CHECK_INTERVAL_SECONDS: "1" });
    // Signal from inside sh so it is a real POSIX signal even under Git Bash on Windows.
    const driver = `sh "${script.replace(/\\/g, "/")}" "${env}" & sup=$!; sleep 2; kill -TERM "$sup"; wait "$sup"; echo "supervisor-exit=$?"`;
    const result = await new Promise<Run>((resolve) => {
      const child = spawn("sh", ["-c", driver], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

    assert.match(result.stdout, /received SIGTERM; stopping/, result.stdout + result.stderr);
    assert.match(result.stdout, /supervisor-exit=0/);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["start", "terminated"]);
    assert.equal(existsSync(pidfile), false);
  });

  it("rejects a missing env file and a bad number", async () => {
    const missing = await runScript(p("does-not-exist.env"));
    assert.equal(missing.code, 2);

    const bad = await runScript(envFile("bad.env", { HEALTH_STALE_SECONDS: "soon", SUPERVISOR_PIDFILE: p("bad.pid") }));
    assert.equal(bad.code, 2);
    assert.match(bad.stdout, /HEALTH_STALE_SECONDS must be a whole number/);
  });
});
