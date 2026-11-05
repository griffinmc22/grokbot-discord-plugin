import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addReaction,
  defaultAckEmoji,
  defaultErrorEmoji,
  describeReactionError,
  markFailed,
  reactionKey,
  resolveReactionEmoji,
} from "./ack.ts";
import { loadConfig } from "./config.ts";
import { workerEnv } from "./supervisor.ts";

function recorder() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function fakeTarget(behavior: "ok" | "reject" | "throw" | "hang" = "ok") {
  const reacted: string[] = [];
  const removed: string[] = [];
  return {
    reacted,
    removed,
    react(emoji: string): Promise<unknown> {
      reacted.push(emoji);
      if (behavior === "throw") {
        throw new Error("sync boom");
      }
      if (behavior === "reject") {
        return Promise.reject(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
      }
      if (behavior === "hang") {
        return new Promise(() => undefined);
      }
      return Promise.resolve();
    },
    async removeOwnReaction(emoji: string) {
      removed.push(emoji);
    },
  };
}

describe("resolveReactionEmoji", () => {
  it("defaults when the variable is unset or an unexpanded placeholder", () => {
    assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, {}), "👀");
    assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: undefined }), "👀");
    assert.equal(
      resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: "${DISCORD_ACK_EMOJI}" }),
      "👀",
    );
    assert.equal(resolveReactionEmoji("DISCORD_ERROR_EMOJI", defaultErrorEmoji, {}), "⚠️");
  });

  it("uses a custom unicode or guild emoji", () => {
    assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: " ✅ " }), "✅");
    assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: '"📥"' }), "📥");
    assert.equal(
      resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: "inbox:123456789012345678" }),
      "inbox:123456789012345678",
    );
    assert.equal(
      resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: "<a:spin:123456789012345678>" }),
      "spin:123456789012345678",
    );
  });

  it("disables on an explicitly empty value or none/off", () => {
    for (const value of ["", "  ", '""', "none", "OFF", "false", "0", "disabled"]) {
      assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: value }), null, value);
    }
    // Keys with stray whitespace still count as present.
    assert.equal(resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { " DISCORD_ACK_EMOJI": "" }), null);
  });

  it("rejects values that are not an emoji", () => {
    assert.throws(
      () => resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: "eyes please" }),
      /DISCORD_ACK_EMOJI must be a unicode emoji/,
    );
    assert.throws(
      () => resolveReactionEmoji("DISCORD_ACK_EMOJI", defaultAckEmoji, { DISCORD_ACK_EMOJI: "../%2e" }),
      /DISCORD_ACK_EMOJI/,
    );
  });

  it("is wired into loadConfig for both variables", () => {
    const env = {
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "111111111111111111",
      DISCORD_CHANNEL_IDS: "222222222222222222",
      DISCORD_ALLOWED_USER_IDS: "333333333333333333",
    };
    const defaults = loadConfig(env);
    assert.equal(defaults.ackEmoji, "👀");
    assert.equal(defaults.errorEmoji, "⚠️");

    const custom = loadConfig({ ...env, DISCORD_ACK_EMOJI: "none", DISCORD_ERROR_EMOJI: "❌" });
    assert.equal(custom.ackEmoji, null);
    assert.equal(custom.errorEmoji, "❌");

    // The supervisor re-exports config to the gateway child; disabled must stay disabled.
    const child = loadConfig(workerEnv(custom));
    assert.equal(child.ackEmoji, null);
    assert.equal(child.errorEmoji, "❌");
  });
});

describe("reactionKey", () => {
  it("uses the id for custom emoji and the character for unicode", () => {
    assert.equal(reactionKey("inbox:123456789012345678"), "123456789012345678");
    assert.equal(reactionKey("👀"), "👀");
  });
});

describe("describeReactionError", () => {
  it("includes the Discord error code and redacts secrets", () => {
    assert.equal(
      describeReactionError(Object.assign(new Error("Missing Permissions"), { code: 50013 })),
      "50013 Missing Permissions",
    );
    assert.equal(describeReactionError(new Error("bad ghp_abcdefghijklmnopqrstuvwxyz1234567890")), "bad [redacted]");
    assert.equal(describeReactionError("plain"), "plain");
  });
});

describe("addReaction", () => {
  it("reacts with the emoji and resolves true", async () => {
    const target = fakeTarget();
    const { lines, log } = recorder();

    assert.equal(await addReaction(target, "👀", log), true);
    assert.deepEqual(target.reacted, ["👀"]);
    assert.deepEqual(lines, []);
  });

  it("does nothing when disabled", async () => {
    const target = fakeTarget();
    const { lines, log } = recorder();

    assert.equal(await addReaction(target, null, log), false);
    assert.deepEqual(target.reacted, []);
    assert.deepEqual(lines, []);
  });

  it("swallows rejections and sync throws, logging one line with the code", async () => {
    const { lines, log } = recorder();

    assert.equal(await addReaction(fakeTarget("reject"), "👀", log), false);
    assert.equal(await addReaction(fakeTarget("throw"), "👀", log), false);
    assert.deepEqual(lines, [
      "grok-discord ack reaction failed: 50013 Missing Permissions",
      "grok-discord ack reaction failed: sync boom",
    ]);
  });

  it("never blocks: a hanging reaction resolves false after the timeout", async () => {
    const { lines, log } = recorder();
    const started = Date.now();

    assert.equal(await addReaction(fakeTarget("hang"), "👀", log, "ack", 20), false);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(lines, ["grok-discord ack reaction failed: timed out after 20ms"]);
  });

  it("returns before the reaction settles, so callers can fire and forget", () => {
    let order = "";
    const pending = addReaction(
      {
        react: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              order += "reacted;";
              resolve(undefined);
            }, 5);
          }),
      },
      "👀",
      () => undefined,
    );
    order += "forwarded;";
    return pending.then(() => assert.equal(order, "forwarded;reacted;"));
  });
});

describe("markFailed", () => {
  it("removes the ack reaction after it lands, then adds the error emoji", async () => {
    const target = fakeTarget();
    const { lines, log } = recorder();
    const ackPending = addReaction(target, "👀", log);

    assert.equal(await markFailed(target, { ackEmoji: "👀", errorEmoji: "⚠️", ackPending }, log), true);
    assert.deepEqual(target.removed, ["👀"]);
    assert.deepEqual(target.reacted, ["👀", "⚠️"]);
    assert.deepEqual(lines, []);
  });

  it("skips removal when the ack never landed and survives removal and error-reaction failures", async () => {
    const { lines, log } = recorder();
    const target = {
      ...fakeTarget("reject"),
      async removeOwnReaction() {
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      },
    };

    const ok = await markFailed(target, { ackEmoji: "👀", errorEmoji: "⚠️", ackPending: Promise.resolve(true) }, log);
    assert.equal(ok, false);
    assert.deepEqual(lines, [
      "grok-discord ack reaction removal failed: 10008 Unknown Message",
      "grok-discord error reaction failed: 50013 Missing Permissions",
    ]);

    const notAcked = fakeTarget();
    await markFailed(notAcked, { ackEmoji: "👀", errorEmoji: "⚠️", ackPending: Promise.resolve(false) }, log);
    assert.deepEqual(notAcked.removed, []);
    assert.deepEqual(notAcked.reacted, ["⚠️"]);
  });

  it("does nothing when the error emoji is disabled", async () => {
    const target = fakeTarget();
    assert.equal(await markFailed(target, { ackEmoji: null, errorEmoji: null }, () => undefined), false);
    assert.deepEqual(target.reacted, []);
  });
});
