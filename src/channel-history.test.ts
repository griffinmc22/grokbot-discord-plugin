import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelType, Routes, type REST } from "discord.js";

import { formatHistoryLine, historyContent, shouldIncludeHistoryMessage } from "./channel-history.ts";
import type { ConnectorConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const ownerId = "333333333333333333";
const strangerId = "444444444444444444";
const botId = "555555555555555555";

const forwardedApiMessage = {
  id: "900000000000000001",
  content: "add to calendar pls",
  author: { id: ownerId, username: "owner", global_name: "Owner" },
  attachments: [],
  embeds: [],
  message_snapshots: [
    {
      message: {
        content: "Book club Thursday 6pm",
        embeds: [{ title: "Book club", description: "Library, room 2", url: "https://example.com/club" }],
        attachments: [
          { filename: "flyer.png", url: "https://cdn.example.com/flyer.png", content_type: "image/png", size: 2048 },
        ],
      },
    },
  ],
};

describe("historyContent", () => {
  it("includes forwarded snapshot text, embed text, and attachment URLs", () => {
    const content = historyContent(forwardedApiMessage);

    assert.match(content, /add to calendar pls/);
    assert.match(content, /\[Forwarded message\]/);
    assert.match(content, /Book club Thursday 6pm/);
    assert.match(content, /\[Embed\] Book club — https:\/\/example\.com\/club/);
    assert.match(content, /Library, room 2/);
    assert.match(content, /\[Attachment\] flyer\.png \(image\/png, 2048 bytes\): https:\/\/cdn\.example\.com\/flyer\.png/);
  });

  it("reads embed-only messages", () => {
    assert.equal(historyContent({ content: "", embeds: [{ title: "Link preview" }] }), "[Embed] Link preview");
  });
});

describe("formatHistoryLine", () => {
  const entry = { id: "1", authorId: ownerId, authorName: "Owner", bot: false, webhook: false, roleIds: [] };

  it("flattens multi-line content onto one redacted line", () => {
    assert.equal(
      formatHistoryLine({ ...entry, content: "note\n\n[Forwarded message]\nkey ghp_abcdefghijklmnopqrstuvwxyz1234567890" }),
      "Owner: note [Forwarded message] key [redacted]",
    );
  });

  it("marks empty messages", () => {
    assert.equal(formatHistoryLine({ ...entry, content: "  " }), "Owner: [empty]");
  });
});

describe("shouldIncludeHistoryMessage", () => {
  const base = { id: "1", bot: false, webhook: false, roleIds: [] };

  it("includes allowlisted users even when they are not the current speaker", () => {
    assert.equal(shouldIncludeHistoryMessage([], [ownerId], strangerId, botId, { ...base, authorId: ownerId }), true);
    assert.equal(shouldIncludeHistoryMessage([], [ownerId], ownerId, botId, { ...base, authorId: strangerId }), false);
    assert.equal(shouldIncludeHistoryMessage([], [ownerId], ownerId, botId, { ...base, authorId: botId }), true);
  });
});

describe("discord_history (REST)", () => {
  it("returns forwarded content for allowlisted users and omits strangers", async () => {
    const config: ConnectorConfig = {
      discordToken: "test-token",
      discordGuildId: guildId,
      discordChannelIds: [channelId],
      discordCategoryIds: [],
      discordAllowedRoleIds: [],
      discordAllowedUserIds: [ownerId],
      intakeMode: true,
      dmIntake: true,
      rateWindowMs: 1000,
      ratePerUser: 6,
      ratePerChannel: 15,
    };

    const stranger = {
      id: "900000000000000002",
      content: "spam",
      author: { id: strangerId, username: "stranger" },
      attachments: [],
      embeds: [],
    };
    const botReply = {
      id: "900000000000000003",
      content: "Added Book club to your calendar.",
      author: { id: botId, username: "grok", bot: true },
      attachments: [],
      embeds: [],
    };

    const fakeRest = {
      async get(route: string) {
        if (route === Routes.channel(channelId)) {
          return { id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: "inbox" };
        }
        if (route === Routes.user("@me")) {
          return { id: botId, username: "grok" };
        }
        if (route === Routes.channelMessages(channelId)) {
          // Discord returns newest first.
          return [botReply, stranger, forwardedApiMessage];
        }
        throw new Error(`unexpected route ${route}`);
      },
    } as unknown as REST;

    const result = await createDiscordRest(config, fakeRest).history(channelId);

    assert.equal(result.lines.length, 2);
    assert.match(result.lines[0] ?? "", /^Owner: add to calendar pls \[Forwarded message\] Book club Thursday 6pm \[Embed\] Book club/);
    assert.match(result.lines[0] ?? "", /https:\/\/cdn\.example\.com\/flyer\.png/);
    assert.equal(result.lines[1], "grok: Added Book club to your calendar.");
  });
});
