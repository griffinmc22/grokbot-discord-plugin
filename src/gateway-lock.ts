// One gateway per bot token, whichever supervisor started it (the MCP-managed
// `supervise` loop or bin/run-forever.sh). The lock is a small JSON file
// { pid, updatedAt } refreshed on every healthy health tick. A holder counts as
// live only if its pid is alive AND it refreshed recently, so a crashed,
// SIGKILLed, or wedged gateway (or a reused pid) never blocks a restart for
// longer than staleMs.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Exit code when another live gateway already holds the lock for this token. */
export const exitLockHeld = 3;

export type GatewayLockOptions = {
  path: string;
  pid: number;
  now: () => number;
  isAlive: (pid: number) => boolean;
  /** A holder that has not refreshed for this long is stale and may be replaced. */
  staleMs: number;
};

export type GatewayLock = {
  /** Re-stamp updatedAt. False if the lock was lost to another process. Never throws. */
  refresh(): boolean;
  /** Remove the lock if it is still ours. Never throws. Safe to call more than once. */
  release(): void;
};

export type AcquireResult = { ok: true; lock: GatewayLock } | { ok: false; holderPid: number; ageMs: number };

type LockState = { pid: number; updatedAt: number };

function readLock(path: string): LockState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockState>;
    if (!Number.isInteger(parsed.pid) || !parsed.pid) {
      return null;
    }
    return { pid: parsed.pid, updatedAt: Number(parsed.updatedAt) || 0 };
  } catch {
    return null;
  }
}

function stamp(options: GatewayLockOptions): string {
  return `${JSON.stringify({ pid: options.pid, updatedAt: options.now() })}\n`;
}

export function acquireGatewayLock(options: GatewayLockOptions): AcquireResult {
  mkdirSync(dirname(options.path), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(options.path, stamp(options), { flag: "wx" });
      return { ok: true, lock: lockHandle(options) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const holder = readLock(options.path);
    if (holder && holder.pid !== options.pid) {
      const ageMs = options.now() - holder.updatedAt;
      if (options.isAlive(holder.pid) && ageMs < options.staleMs) {
        return { ok: false, holderPid: holder.pid, ageMs };
      }
    }

    // Ours from a previous life, unreadable, dead, or stale: take it over.
    try {
      unlinkSync(options.path);
    } catch {
      // someone else removed it first; retry the exclusive create
    }
  }

  throw new Error("could not acquire the gateway lock");
}

function lockHandle(options: GatewayLockOptions): GatewayLock {
  let released = false;

  return {
    refresh() {
      if (released) {
        return false;
      }
      try {
        // Missing (someone cleaned the runtime dir) is re-created; another pid means we lost it.
        const holder = readLock(options.path);
        if (holder && holder.pid !== options.pid) {
          return false;
        }
        const tmp = `${options.path}.${options.pid}.tmp`;
        writeFileSync(tmp, stamp(options));
        renameSync(tmp, options.path);
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        if (readLock(options.path)?.pid === options.pid) {
          unlinkSync(options.path);
        }
      } catch {
        // already gone
      }
    },
  };
}
