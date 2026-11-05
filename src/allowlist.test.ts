import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertChannelAllowed, channelIsAllowed, dmIsAllowed } from "./allowlist.ts";
import { deliverOutbound } from "./outbound.ts";

const config = {
  discordGuildId: "guild-1",
  discordChannelIds: ["chan-1"],
};

describe("allowlist enforcement on send", () => {
  it("allows only the configured guild and parent channels", () => {
    assert.equal(channelIsAllowed(config, "guild-1", "chan-1"), true);
    assert.equal(channelIsAllowed(config, "guild-2", "chan-1"), false);
    assert.equal(channelIsAllowed(config, "guild-1", "chan-9"), false);
    assert.equal(channelIsAllowed(config, null, "chan-1"), false);
    assert.throws(() => assertChannelAllowed(config, "guild-1", "chan-9"), /allowlist/);
  });

  it("refuses deliverOutbound outside the allowlist before posting", async () => {
    const posted: string[] = [];
    await assert.rejects(
      deliverOutbound({
        config,
        guildId: "guild-1",
        parentChannelId: "chan-9",
        inThread: false,
        replyToMessageId: "msg-1",
        text: "hello",
        async post(chunk) {
          posted.push(chunk);
        },
      }),
      /allowlist/,
    );
    assert.deepEqual(posted, []);
  });

  it("posts nothing for SILENCE even on an allowlisted channel", async () => {
    const posted: string[] = [];
    const result = await deliverOutbound({
      config,
      guildId: "guild-1",
      parentChannelId: "chan-1",
      inThread: false,
      replyToMessageId: "msg-1",
      text: "SILENCE",
      async post(chunk) {
        posted.push(chunk);
      },
    });
    assert.equal(result.posted, false);
    assert.deepEqual(posted, []);
  });

  it("replies on the first parent-channel chunk, then sends", async () => {
    const modes: string[] = [];
    const text = `${"a".repeat(1900)}-${"b".repeat(20)}`;
    const result = await deliverOutbound({
      config,
      guildId: "guild-1",
      parentChannelId: "chan-1",
      inThread: false,
      replyToMessageId: "msg-1",
      text,
      async post(_chunk, mode) {
        modes.push(mode);
      },
    });
    assert.equal(result.posted, true);
    assert.deepEqual(modes, ["reply", "send"]);
  });

  it("never replies when the ping came from a thread", async () => {
    const modes: string[] = [];
    await deliverOutbound({
      config,
      guildId: "guild-1",
      parentChannelId: "chan-1",
      inThread: true,
      replyToMessageId: "msg-1",
      text: "hello from a thread",
      async post(_chunk, mode) {
        modes.push(mode);
      },
    });
    assert.deepEqual(modes, ["send"]);
  });
});

describe("category allowlist", () => {
  const withCategory = { discordGuildId: "guild-1", discordChannelIds: ["chan-1"], discordCategoryIds: ["cat-1"] };

  it("allows a channel whose category is listed, and keeps direct channels working", () => {
    assert.equal(channelIsAllowed(withCategory, "guild-1", "chan-7", "cat-1"), true);
    assert.equal(channelIsAllowed(withCategory, "guild-1", "chan-1", null), true);
  });

  it("rejects channels outside the category, without a category, or in another guild", () => {
    assert.equal(channelIsAllowed(withCategory, "guild-1", "chan-7", "cat-2"), false);
    assert.equal(channelIsAllowed(withCategory, "guild-1", "chan-7", null), false);
    assert.equal(channelIsAllowed(withCategory, "guild-2", "chan-7", "cat-1"), false);
    assert.equal(channelIsAllowed(config, "guild-1", "chan-7", "cat-1"), false);
    assert.throws(() => assertChannelAllowed(withCategory, "guild-1", "chan-7", "cat-2"), /allowlist/);
  });
});

describe("DM allowlist", () => {
  const dmConfig = { discordGuildId: "guild-1", discordChannelIds: ["chan-1"], discordAllowedUserIds: ["user-1"], dmIntake: true };

  it("allows a DM whose recipients include an allowed user", () => {
    assert.equal(dmIsAllowed(dmConfig, ["user-1"]), true);
    assert.doesNotThrow(() => assertChannelAllowed(dmConfig, null, "dm-1", null, ["user-1"]));
  });

  it("rejects other DMs, DMs with DM intake off, and DMs with no user allowlist", () => {
    assert.equal(dmIsAllowed(dmConfig, ["user-2"]), false);
    assert.equal(dmIsAllowed(dmConfig, []), false);
    assert.equal(dmIsAllowed({ ...dmConfig, dmIntake: false }, ["user-1"]), false);
    assert.equal(dmIsAllowed({ ...dmConfig, discordAllowedUserIds: [] }, ["user-1"]), false);
    assert.throws(() => assertChannelAllowed(dmConfig, null, "dm-1", null, ["user-2"]), /allowlist/);
  });

  it("does not let a DM scope fall through to the guild check", () => {
    assert.throws(() => assertChannelAllowed(dmConfig, "guild-1", "chan-1", null, ["user-2"]), /allowlist/);
  });
});
