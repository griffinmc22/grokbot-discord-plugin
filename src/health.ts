// Gateway health watchdog. Pure logic over injected clock/status/ping/fs so it
// is testable without Discord. The point: a process that is alive but silently
// disconnected must notice and exit, so whatever supervises it restarts it.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { rawEnvEntry, usableEnvValue, type EnvMap } from "./env.ts";
import { redactSecrets } from "./redact.ts";

export const defaultHealthIntervalMs = 30_000;
export const defaultMaxUnhealthyMs = 120_000;
export const defaultPingGraceMs = 60_000;
export const defaultMaxPingMs = 10_000;
export const defaultRestIntervalMs = 5 * 60_000;
export const defaultRestMaxFailures = 3;
export const defaultRestTimeoutMs = 15_000;

/** Exit code for an unhealthy or fatally broken gateway: restart me. */
export const exitUnhealthy = 1;

export type HealthConfig = {
  intervalMs: number;
  maxUnhealthyMs: number;
  pingGraceMs: number;
  maxPingMs: number;
  restIntervalMs: number;
  restMaxFailures: number;
  restTimeoutMs: number;
  /** Where the last-healthy timestamp is written. */
  healthFile: string;
  /** DISCORD_DEBUG: log heartbeat debug lines. */
  debug: boolean;
};

function positiveMs(name: string, fallback: number, env: EnvMap, min = 1): number {
  const raw = usableEnvValue(rawEnvEntry(name, env));
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }

  return value;
}

export function loadHealthConfig(env: EnvMap, pluginRoot: string): HealthConfig {
  const intervalMs = positiveMs("HEALTH_INTERVAL_MS", defaultHealthIntervalMs, env, 1_000);
  const maxUnhealthyMs = positiveMs("HEALTH_MAX_UNHEALTHY_MS", defaultMaxUnhealthyMs, env, 1_000);
  if (maxUnhealthyMs < intervalMs) {
    throw new Error("HEALTH_MAX_UNHEALTHY_MS must be at least HEALTH_INTERVAL_MS");
  }

  const debugRaw = usableEnvValue(rawEnvEntry("DISCORD_DEBUG", env));
  if (debugRaw && !/^(?:1|true|yes|on|0|false|no|off)$/i.test(debugRaw)) {
    throw new Error("DISCORD_DEBUG must be true or false");
  }

  return {
    intervalMs,
    maxUnhealthyMs,
    pingGraceMs: defaultPingGraceMs,
    maxPingMs: defaultMaxPingMs,
    restIntervalMs: positiveMs("HEALTH_REST_INTERVAL_MS", defaultRestIntervalMs, env, 1_000),
    restMaxFailures: defaultRestMaxFailures,
    restTimeoutMs: defaultRestTimeoutMs,
    healthFile: usableEnvValue(rawEnvEntry("DISCORD_HEALTH_FILE", env)) ?? join(pluginRoot, ".health"),
    debug: Boolean(debugRaw && /^(?:1|true|yes|on)$/i.test(debugRaw)),
  };
}

/** "<epoch-ms> <ISO>\n": the first field is easy to read from shell. */
export function healthFileContents(nowMs: number): string {
  return `${nowMs} ${new Date(nowMs).toISOString()}\n`;
}

/** Write via tmp + rename so a reader never sees a half-written file. */
export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function timestamped(line: string, nowMs = Date.now()): string {
  return `${new Date(nowMs).toISOString()} ${redactSecrets(line)}`;
}

export type HealthDeps = {
  now: () => number;
  /** True when the gateway connection reports Ready. */
  isReady: () => boolean;
  /** Human-readable connection status, for logs. */
  statusLabel: () => string;
  /** Heartbeat latency in ms; -1 until the first heartbeat ack. */
  ping: () => number;
  writeHealthFile: (path: string, contents: string) => void;
  /** Authenticated REST round trip; rejects on failure. */
  restCheck: () => Promise<unknown>;
  exit: (code: number) => void;
  log: (line: string) => void;
};

export type HealthState = "healthy" | "unhealthy" | "exiting";

export type HealthTick = {
  state: HealthState;
  reason?: string;
  unhealthyForMs?: number;
};

export function createHealthMonitor(config: HealthConfig, deps: HealthDeps) {
  const startedAt = deps.now();
  // Counting from start means a gateway that never becomes Ready also gets restarted.
  let unhealthySince: number | null = startedAt;
  let readySince: number | null = null;
  let lastActivityAt = startedAt;
  let restFailures = 0;
  let restInFlight = false;
  let exited = false;
  let loggedUnhealthy = false;
  let writeFailing = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  function exit(reason: string): void {
    if (exited) {
      return;
    }
    exited = true;
    deps.log(timestamped(`grok-discord health: ${reason}; exiting with code ${exitUnhealthy} so the supervisor restarts the gateway`, deps.now()));
    deps.exit(exitUnhealthy);
  }

  function pingProblem(now: number): string | null {
    const ping = deps.ping();
    if (Number.isFinite(ping) && ping >= 0 && ping < config.maxPingMs) {
      return null;
    }

    // -1 means "no heartbeat ack yet": fine right after (re)connecting, not forever.
    if (ping === -1 && readySince !== null && now - readySince <= config.pingGraceMs) {
      return null;
    }

    return `ping ${ping}ms is not sane`;
  }

  function tick(): HealthTick {
    if (exited) {
      return { state: "exiting" };
    }

    const now = deps.now();
    const ready = deps.isReady();
    if (ready && readySince === null) {
      readySince = now;
    } else if (!ready) {
      readySince = null;
    }

    const problem = ready ? pingProblem(now) : `status ${deps.statusLabel()}`;

    if (!problem) {
      if (unhealthySince !== null && loggedUnhealthy) {
        deps.log(timestamped(`grok-discord health: recovered after ${now - unhealthySince}ms`, now));
      }
      unhealthySince = null;
      loggedUnhealthy = false;
      try {
        deps.writeHealthFile(config.healthFile, healthFileContents(now));
        if (writeFailing) {
          deps.log(timestamped("grok-discord health: health file writable again", now));
        }
        writeFailing = false;
      } catch (error) {
        if (!writeFailing) {
          const detail = error instanceof Error ? error.message : String(error);
          deps.log(timestamped(`grok-discord health: cannot write health file: ${detail}`, now));
        }
        writeFailing = true;
      }
      return { state: "healthy" };
    }

    unhealthySince ??= now;
    const unhealthyForMs = now - unhealthySince;
    // One line per unhealthy stretch, not one per tick.
    if (!loggedUnhealthy) {
      deps.log(
        timestamped(
          `grok-discord health: unhealthy (${problem}); last gateway activity ${now - lastActivityAt}ms ago; ` +
            `exiting if not recovered within ${config.maxUnhealthyMs}ms`,
          now,
        ),
      );
      loggedUnhealthy = true;
    }

    if (unhealthyForMs > config.maxUnhealthyMs) {
      exit(`unhealthy for ${unhealthyForMs}ms (${problem})`);
      return { state: "exiting", reason: problem, unhealthyForMs };
    }

    return { state: "unhealthy", reason: problem, unhealthyForMs };
  }

  async function restTick(): Promise<number> {
    if (exited || restInFlight) {
      return restFailures;
    }

    restInFlight = true;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        deps.restCheck(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${config.restTimeoutMs}ms`)), config.restTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (restFailures > 0) {
        deps.log(timestamped(`grok-discord health: REST liveness check ok after ${restFailures} failure(s)`, deps.now()));
      }
      restFailures = 0;
    } catch (error) {
      restFailures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      deps.log(
        timestamped(
          `grok-discord health: REST liveness check failed (${restFailures}/${config.restMaxFailures}): ${detail}`,
          deps.now(),
        ),
      );
      if (restFailures >= config.restMaxFailures) {
        exit(`REST liveness check failed ${restFailures} times in a row`);
      }
    } finally {
      restInFlight = false;
    }

    return restFailures;
  }

  return {
    tick,
    restTick,
    /** Call on any sign of life from the gateway (shard events, messages). */
    noteActivity(): void {
      lastActivityAt = deps.now();
    },
    get restFailures(): number {
      return restFailures;
    },
    /** Start the timers. They are unref'd: the Discord client is what keeps the process alive. */
    start(): void {
      if (timers.length > 0) {
        return;
      }
      const health = setInterval(() => {
        tick();
      }, config.intervalMs);
      const rest = setInterval(() => {
        void restTick();
      }, config.restIntervalMs);
      health.unref();
      rest.unref();
      timers.push(health, rest);
    },
    stop(): void {
      for (const timer of timers.splice(0)) {
        clearInterval(timer);
      }
    },
  };
}

export type HealthMonitor = ReturnType<typeof createHealthMonitor>;

/** Minimal process surface, so handlers can be tested with an EventEmitter. */
export type ProcessLike = {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

export type LifecycleDeps = {
  /** Stop timers, destroy the Discord client, release locks. May be async; bounded by shutdownTimeoutMs. */
  shutdown: () => unknown;
  exit: (code: number) => void;
  log: (line: string) => void;
  now?: () => number;
  shutdownTimeoutMs?: number;
};

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  return String(value);
}

/**
 * unhandledRejection / uncaughtException: log one line and exit 1 so the
 * supervisor restarts. SIGTERM / SIGINT: shut down quickly and exit 0.
 */
export function installProcessHandlers(proc: ProcessLike, deps: LifecycleDeps): void {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.shutdownTimeoutMs ?? 3_000;
  let exiting = false;

  const finish = (code: number) => {
    if (exiting) {
      return;
    }
    exiting = true;
    let done = false;
    const end = () => {
      if (!done) {
        done = true;
        deps.exit(code);
      }
    };
    const timer = setTimeout(end, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => deps.shutdown())
      .catch((error: unknown) => deps.log(timestamped(`grok-discord shutdown error: ${describe(error)}`, now())))
      .finally(() => {
        clearTimeout(timer);
        end();
      });
  };

  proc.on("unhandledRejection", (reason) => {
    deps.log(timestamped(`grok-discord fatal: unhandled rejection: ${describe(reason)}`, now()));
    finish(exitUnhealthy);
  });
  proc.on("uncaughtException", (error) => {
    deps.log(timestamped(`grok-discord fatal: uncaught exception: ${describe(error)}`, now()));
    finish(exitUnhealthy);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    proc.on(signal, () => {
      deps.log(timestamped(`grok-discord received ${signal}; shutting down`, now()));
      finish(0);
    });
  }
}
