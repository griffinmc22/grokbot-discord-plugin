import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelType, Routes, type REST } from "discord.js";

import type { ConnectorConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";

const guildId = "111111111111111111";
const listedChannelId = "222222222222222222";
const ownerId = "333333333333333333";
const botId = "555555555555555555";
const inboxCategoryId = "600000000000000001";
const otherCategoryId = "600000000000000002";
const categoryChannelId = "700000000000000001";
const otherCategoryChannelId = "700000000000000002";
const threadId = "700000000000000003";
const forumId = "700000000000000004";
const forumPostId = "700000000000000005";
const messageId = "900000000000000001";

const channels: Record<string, Record<string, unknown>> = {
  [listedChannelId]: { id: listedChannelId, guild_id: guildId, type: ChannelType.GuildText, name: "listed", parent_id: null },
  [categoryChannelId]: {
    id: categoryChannelId,
    guild_id: guildId,
    type: ChannelType.GuildText,
    name: "inbox",
    parent_id: inboxCategoryId,
  },
  [otherCategoryChannelId]: {
    id: otherCategoryChannelId,
    guild_id: guildId,
    type: ChannelType.GuildText,
    name: "general",
    parent_id: otherCategoryId,
  },
  [threadId]: { id: threadId, guild_id: guildId, type: ChannelType.PublicThread, name: "inbox-thread", parent_id: categoryChannelId },
  [forumId]: { id: forumId, guild_id: guildId, type: ChannelType.GuildForum, name: "forum", parent_id: inboxCategoryId },
  [forumPostId]: { id: forumPostId, guild_id: guildId, type: ChannelType.PublicThread, name: "post", parent_id: forumId },
};

function createFakeRest() {
  const gets: string[] = [];
  const posts: { route: string; body: Record<string, unknown> }[] = [];
  let nextId = 800000000000000000n;

  const rest = {
    async get(route: string) {
      gets.push(route);
      const channelMatch = /^\/channels\/(\d+)$/.exec(route);
      if (channelMatch?.[1] && channels[channelMatch[1]]) {
        return channels[channelMatch[1]];
      }
      if (route === Routes.user("@me")) {
        return { id: botId, username: "grok" };
      }
      if (route === Routes.guildChannels(guildId)) {
        // The guild channel list never includes threads; the forum under the inbox category must be skipped.
        return Object.values(channels).filter((channel) => channel.type !== ChannelType.PublicThread);
      }
      const messagesMatch = /^\/channels\/(\d+)\/messages$/.exec(route);
      if (messagesMatch) {
        return [
          {
            id: messageId,
            content: "note",
            author: { id: ownerId, username: "owner" },
            attachments: [],
            embeds: [],
            message_snapshots: [{ message: { content: "forwarded event", embeds: [], attachments: [] } }],
          },
        ];
      }
      throw new Error(`unexpected GET ${route}`);
    },
    async post(route: string, options: { body: Record<string, unknown> }) {
      posts.push({ route, body: options.body });
      nextId += 1n;
      return { id: String(nextId) };
    },
  } as unknown as REST;

  return { rest, gets, posts };
}

function categoryConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    discordToken: "test-token",
    discordGuildId: guildId,
    discordChannelIds: [listedChannelId],
    discordCategoryIds: [inboxCategoryId],
    discordAllowedRoleIds: [],
    discordAllowedUserIds: [ownerId],
    intakeMode: true,
    rateWindowMs: 1000,
    ratePerUser: 6,
    ratePerChannel: 15,
    ...overrides,
  };
}

describe("discord REST with DISCORD_CATEGORY_IDS", () => {
  it("allows history and send in a text channel under an allowlisted category", async () => {
    const fake = createFakeRest();
    const discord = createDiscordRest(categoryConfig(), fake.rest);

    const history = await discord.history(categoryChannelId);
    assert.deepEqual(history.lines, ["owner: note [Forwarded message] forwarded event"]);

    const sent = await discord.send(categoryChannelId, "Added to calendar.");
    assert.equal(sent.posted, true);
    assert.equal(sent.channelId, categoryChannelId);
    assert.deepEqual(
      fake.posts.map((post) => post.route),
      [Routes.channelMessages(categoryChannelId)],
    );
  });

  it("allows a reply from a thread under a category channel and posts in the parent channel", async () => {
    const fake = createFakeRest();
    const discord = createDiscordRest(categoryConfig(), fake.rest);

    const resolved = await discord.assertResolved(threadId);
    assert.equal(resolved.parentChannelId, categoryChannelId);
    assert.equal(resolved.categoryId, inboxCategoryId);
    assert.equal(resolved.inThread, true);

    const result = await discord.reply(threadId, messageId, "Done.");
    assert.equal(result.posted, true);
    assert.equal(fake.posts[0]?.route, Routes.channelMessages(categoryChannelId));
    // Thread pings never use a message reference in the parent.
    assert.equal(fake.posts[0]?.body.message_reference, undefined);
  });

  it("rejects channels in other categories and threads whose parent is not a text channel", async () => {
    const fake = createFakeRest();
    const discord = createDiscordRest(categoryConfig(), fake.rest);

    await assert.rejects(discord.history(otherCategoryChannelId), /allowlist/);
    await assert.rejects(discord.send(otherCategoryChannelId, "hi"), /allowlist/);
    await assert.rejects(discord.reply(forumPostId, messageId, "hi"), /allowlist/);
    assert.deepEqual(fake.posts, []);
  });

  it("rejects category channels when categories are not configured", async () => {
    const fake = createFakeRest();
    const discord = createDiscordRest(categoryConfig({ discordCategoryIds: [] }), fake.rest);

    await assert.rejects(discord.reply(threadId, messageId, "hi"), /allowlist/);
    // Without categories, a thread's parent is not fetched just to read its category.
    assert.equal(fake.gets.includes(Routes.channel(categoryChannelId)), false);
    await assert.rejects(discord.send(categoryChannelId, "hi"), /allowlist/);
    assert.deepEqual(fake.posts, []);
  });

  it("lists directly configured channels plus text channels under allowlisted categories", async () => {
    const fake = createFakeRest();
    const discord = createDiscordRest(categoryConfig(), fake.rest);

    const listed = await discord.listChannels();
    assert.deepEqual(
      listed.map((channel) => channel.id),
      [listedChannelId, categoryChannelId],
    );
  });
});
