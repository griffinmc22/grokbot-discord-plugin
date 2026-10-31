// Best-effort acknowledgement reactions. Nothing here may throw into, or hold up,
// the forwarding path: failures are logged as one stderr line and swallowed.

import { isUnresolvedPlaceholder, rawEnvEntry, unquoteEnvValue, type EnvMap } from "./env.ts";
import { assertSafeEmoji } from "./ids.ts";
import { redactSecrets } from "./redact.ts";

export const defaultAckEmoji = "👀";
export const defaultErrorEmoji = "⚠️";
export const reactionTimeoutMs = 3_000;

const disabledValue = /^(?:none|off|false|no|0|disabled?)$/i;
const customEmojiMarkup = /^<a?:([a-zA-Z0-9_]{1,32}):(\d{17,20})>$/;
const customEmojiPair = /^[a-zA-Z0-9_]{1,32}:(\d{17,20})$/;

/**
 * Reaction emoji from env:
 * - unset (or an unexpanded ${VAR} placeholder) -> fallback
 * - set to "" or none/off/false/no/0/disabled -> null (reaction off)
 * - unicode emoji, name:id, or <:name:id> / <a:name:id> -> that emoji (custom normalized to name:id)
 */
export function resolveReactionEmoji(name: string, fallback: string, env: EnvMap): string | null {
  const raw = rawEnvEntry(name, env);
  if (raw === undefined) {
    return fallback;
  }

  const value = unquoteEnvValue(raw);
  if (value && isUnresolvedPlaceholder(value)) {
    return fallback;
  }

  if (!value || disabledValue.test(value)) {
    return null;
  }

  const markup = customEmojiMarkup.exec(value);
  const candidate = markup ? `${markup[1]}:${markup[2]}` : value;
  try {
    return assertSafeEmoji(candidate);
  } catch {
    throw new Error(`${name} must be a unicode emoji, name:id, <:name:id>, or none/off to disable`);
  }
}

/** Key Discord's reaction cache uses: the id for custom emoji, the character(s) for unicode. */
export function reactionKey(emoji: string): string {
  return customEmojiPair.exec(emoji)?.[1] ?? emoji;
}

/** "50013 Missing Permissions" style detail, with no secrets and bounded length. */
export function describeReactionError(error: unknown): string {
  if (error instanceof Error || (error && typeof error === "object")) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const text = typeof message === "string" ? message : "unknown error";
    const detail = code !== undefined && code !== null && code !== "" ? `${String(code)} ${text}` : text;
    return redactSecrets(detail.replace(/\s+/g, " ").trim()).slice(0, 200);
  }

  return redactSecrets(String(error)).slice(0, 200);
}

export type Reactable = {
  react(emoji: string): Promise<unknown>;
};

export type RemovableReactable = Reactable & {
  /** Remove the bot's own reaction with this emoji. Optional; best-effort. */
  removeOwnReaction?(emoji: string): Promise<unknown>;
};

export type ReactionLogger = (line: string) => void;

export const stderrReactionLogger: ReactionLogger = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * React and report success. Never rejects. Resolves false when disabled, on
 * failure, or after timeoutMs (the underlying request may still finish later).
 */
export function addReaction(
  target: Reactable,
  emoji: string | null,
  log: ReactionLogger,
  label = "ack",
  timeoutMs = reactionTimeoutMs,
): Promise<boolean> {
  if (!emoji) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean, failure?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (failure) {
        log(`grok-discord ${label} reaction failed: ${failure}`);
      }
      resolve(ok);
    };

    const timer = setTimeout(() => settle(false, `timed out after ${timeoutMs}ms`), timeoutMs);

    try {
      target.react(emoji).then(
        () => settle(true),
        (error: unknown) => settle(false, describeReactionError(error)),
      );
    } catch (error) {
      settle(false, describeReactionError(error));
    }
  });
}

export type FailureReactionOptions = {
  ackEmoji: string | null;
  errorEmoji: string | null;
  /** The in-flight ack reaction, so removal does not race it. */
  ackPending?: Promise<boolean>;
  timeoutMs?: number;
};

/** On a failed turn: drop the ack reaction if possible, then add the error reaction. Never rejects. */
export async function markFailed(
  target: RemovableReactable,
  options: FailureReactionOptions,
  log: ReactionLogger,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? reactionTimeoutMs;
  const acked = options.ackPending ? await options.ackPending : false;

  if (acked && options.ackEmoji && target.removeOwnReaction && options.ackEmoji !== options.errorEmoji) {
    try {
      await target.removeOwnReaction(options.ackEmoji);
    } catch (error) {
      log(`grok-discord ack reaction removal failed: ${describeReactionError(error)}`);
    }
  }

  return addReaction(target, options.errorEmoji, log, "error", timeoutMs);
}
