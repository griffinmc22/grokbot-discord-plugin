import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isDirectedAtBot,
  memberHasAllowedRole,
  mentionsBot,
  namesBot,
  shouldHandle,
  stripBotMentions,
  userIsAllowed,
} from "./filters.ts";

const allow = {
  configuredGuildId: "guild-1",
  configuredChannelIds: ["chan-1", "chan-2"],
};

describe("shouldHandle", () => {
  it("drops bots, webhooks, DMs, other guilds, and other channels", () => {
    const ok = {
      authorIsBot: false,
      webhookId: null,
      guildId: "guild-1",
      parentChannelId: "chan-1",
      ...allow,
    };

    assert.equal(shouldHandle(ok), true);
    assert.equal(shouldHandle({ ...ok, authorIsBot: true }), false);
    assert.equal(shouldHandle({ ...ok, webhookId: "hook" }), false);
    assert.equal(shouldHandle({ ...ok, guildId: null }), false);
    assert.equal(shouldHandle({ ...ok, guildId: "guild-2" }), false);
    assert.equal(shouldHandle({ ...ok, parentChannelId: "chan-9" }), false);
    assert.equal(shouldHandle({ ...ok, parentChannelId: null }), false);
  });

  it("allows a thread whose parent is allowlisted", () => {
    assert.equal(
      shouldHandle({
        authorIsBot: false,
        guildId: "guild-1",
        parentChannelId: "chan-2",
        ...allow,
      }),
      true,
    );
  });
});

describe("shouldHandle with categories", () => {
  const scope = {
    authorIsBot: false,
    webhookId: null,
    guildId: "guild-1",
    configuredGuildId: "guild-1",
    configuredChannelIds: [],
    configuredCategoryIds: ["cat-inbox"],
  };

  it("handles a channel whose category is allowlisted", () => {
    assert.equal(shouldHandle({ ...scope, parentChannelId: "chan-7", categoryId: "cat-inbox" }), true);
  });

  it("handles a thread under a channel in an allowlisted category (parent channel + its category)", () => {
    // For a thread, parentChannelId is the thread's parent text channel and categoryId is that channel's parentId.
    assert.equal(shouldHandle({ ...scope, parentChannelId: "chan-7", categoryId: "cat-inbox" }), true);
    assert.equal(shouldHandle({ ...scope, parentChannelId: "chan-7", categoryId: null }), false);
  });

  it("rejects channels outside the category, other guilds, bots, and webhooks", () => {
    assert.equal(shouldHandle({ ...scope, parentChannelId: "chan-7", categoryId: "cat-other" }), false);
    assert.equal(shouldHandle({ ...scope, parentChannelId: "chan-7" }), false);
    assert.equal(shouldHandle({ ...scope, guildId: "guild-2", parentChannelId: "chan-7", categoryId: "cat-inbox" }), false);
    assert.equal(shouldHandle({ ...scope, authorIsBot: true, parentChannelId: "chan-7", categoryId: "cat-inbox" }), false);
    assert.equal(shouldHandle({ ...scope, webhookId: "hook", parentChannelId: "chan-7", categoryId: "cat-inbox" }), false);
  });

  it("still handles directly listed channels with no category", () => {
    assert.equal(
      shouldHandle({ ...scope, configuredChannelIds: ["chan-1"], parentChannelId: "chan-1", categoryId: null }),
      true,
    );
  });
});

describe("isDirectedAtBot", () => {
  const names = ["Grok", "ninja-bot"];

  it("accepts mentions, replies to the bot, name prefixes, and follow-ups", () => {
    assert.equal(
      isDirectedAtBot({ mentionedBot: true, isReplyToBot: false, content: "hi", botNames: names, followUp: false }),
      true,
    );
    assert.equal(
      isDirectedAtBot({ mentionedBot: false, isReplyToBot: true, content: "hi", botNames: names, followUp: false }),
      true,
    );
    assert.equal(
      isDirectedAtBot({
        mentionedBot: false,
        isReplyToBot: false,
        content: "hey grok, status",
        botNames: names,
        followUp: false,
      }),
      true,
    );
    assert.equal(
      isDirectedAtBot({
        mentionedBot: false,
        isReplyToBot: false,
        content: "yo ninja-bot",
        botNames: names,
        followUp: false,
      }),
      true,
    );
    assert.equal(
      isDirectedAtBot({
        mentionedBot: false,
        isReplyToBot: false,
        content: "<@123> hello",
        botNames: names,
        followUp: true,
      }),
      true,
    );
  });

  it("drops ambient chat", () => {
    assert.equal(
      isDirectedAtBot({
        mentionedBot: false,
        isReplyToBot: false,
        content: "good morning everyone",
        botNames: names,
        followUp: false,
      }),
      false,
    );
    assert.equal(namesBot("agreement among groks", ["Grok"]), false);
  });

  it("matches a name prefix after stripping mentions", () => {
    assert.equal(namesBot("<@99> hey Grok ping", ["Grok"]), true);
    assert.equal(namesBot("Grok ping", ["Grok"]), true);
  });

  it("matches a whole-word name anywhere, not a prefix of a longer word", () => {
    assert.equal(namesBot("ask Chief later", ["Chief"]), true);
    assert.equal(namesBot("ghost say hello to chief", ["chief"]), true);
    assert.equal(namesBot("chiefest", ["chief"]), false);
  });
});

describe("isDirectedAtBot in intake mode (guild: mention or reply required)", () => {
  const base = { intakeMode: true, mentionedBot: false, isReplyToBot: false, botNames: ["Grok"], followUp: false };

  it("accepts a real @mention", () => {
    assert.equal(isDirectedAtBot({ ...base, mentionedBot: true, content: "add dentist tuesday" }), true);
  });

  it("accepts a reply to a bot message", () => {
    assert.equal(isDirectedAtBot({ ...base, isReplyToBot: true, content: "make it 4pm instead" }), true);
  });

  it("drops plain notes, the bot's name in text, and open follow-up windows", () => {
    assert.equal(isDirectedAtBot({ ...base, content: "dinner with sam friday 7pm" }), false);
    assert.equal(isDirectedAtBot({ ...base, content: "" }), false);
    assert.equal(isDirectedAtBot({ ...base, content: "hey grok, add dentist tuesday" }), false);
    assert.equal(isDirectedAtBot({ ...base, content: "@Grok add dentist" }), false);
    assert.equal(isDirectedAtBot({ ...base, content: "anything", followUp: true }), false);
  });

  it("treats every handled DM as directed, with no mention", () => {
    assert.equal(isDirectedAtBot({ ...base, isDm: true, content: "dinner with sam friday 7pm" }), true);
    assert.equal(isDirectedAtBot({ ...base, isDm: true, content: "" }), true);
  });

  it("keeps legacy chat mode name matching when intake mode is off", () => {
    assert.equal(isDirectedAtBot({ ...base, intakeMode: false, content: "hey grok, add dentist" }), true);
    assert.equal(isDirectedAtBot({ ...base, intakeMode: false, content: "dinner with sam friday 7pm" }), false);
  });
});

describe("shouldHandle DM path", () => {
  const owner = "333333333333333333";
  const stranger = "444444444444444444";
  const dm = {
    authorIsBot: false,
    webhookId: null,
    guildId: null,
    parentChannelId: "777777777777777777",
    configuredGuildId: "guild-1",
    configuredChannelIds: ["chan-1"],
    isDm: true,
    authorId: owner,
    allowedUserIds: [owner],
    dmIntake: true,
  };

  it("handles DMs from an allowed user, bypassing the guild/channel allowlist", () => {
    assert.equal(shouldHandle(dm), true);
  });

  it("ignores DMs from other users, bots, webhooks, and when DM intake is off", () => {
    assert.equal(shouldHandle({ ...dm, authorId: stranger }), false);
    assert.equal(shouldHandle({ ...dm, authorIsBot: true }), false);
    assert.equal(shouldHandle({ ...dm, webhookId: "hook" }), false);
    assert.equal(shouldHandle({ ...dm, dmIntake: false }), false);
  });

  it("fails closed for DMs when the user allowlist is empty", () => {
    assert.equal(shouldHandle({ ...dm, allowedUserIds: [] }), false);
    assert.equal(shouldHandle({ ...dm, allowedUserIds: undefined }), false);
  });

  it("never treats a guild-less message as a guild message", () => {
    assert.equal(shouldHandle({ ...dm, isDm: false }), false);
  });
});

describe("mentionsBot", () => {
  const botId = "555555555555555555";

  it("matches a direct user mention or the bot's managed role", () => {
    assert.equal(mentionsBot({ mentionedUserIds: [botId], mentionedRoles: [] }, botId), true);
    assert.equal(mentionsBot({ mentionedUserIds: [], mentionedRoles: [{ id: "role-1", botId }] }, botId), true);
  });

  it("ignores other users, ordinary roles, and a missing bot id", () => {
    assert.equal(mentionsBot({ mentionedUserIds: ["333333333333333333"], mentionedRoles: [] }, botId), false);
    assert.equal(mentionsBot({ mentionedUserIds: [], mentionedRoles: [{ id: "role-1", botId: null }] }, botId), false);
    assert.equal(mentionsBot({ mentionedUserIds: [botId], mentionedRoles: [] }, undefined), false);
  });
});

describe("stripBotMentions", () => {
  const botId = "555555555555555555";

  it("removes the bot's user and managed-role mentions and keeps other text and mentions", () => {
    assert.equal(stripBotMentions(`<@${botId}> add dentist tuesday`, botId), "add dentist tuesday");
    assert.equal(stripBotMentions(`hey <@!${botId}>  research   this`, botId), "hey research this");
    assert.equal(stripBotMentions(`<@&666666666666666666> ping`, botId, ["666666666666666666"]), "ping");
    assert.equal(stripBotMentions(`<@${botId}> invite <@333333333333333333>`, botId), "invite <@333333333333333333>");
  });

  it("keeps line breaks in multi-line notes", () => {
    assert.equal(stripBotMentions(`<@${botId}>\nline one\n  line two`, botId), "line one\nline two");
  });
});

describe("userIsAllowed", () => {
  it("only admits listed user IDs when the allowlist is set", () => {
    assert.equal(userIsAllowed(["333333333333333333"], "333333333333333333"), true);
    assert.equal(userIsAllowed(["333333333333333333"], "444444444444444444"), false);
  });

  it("admits anyone when the list is empty (chat mode only; intake mode refuses to load)", () => {
    assert.equal(userIsAllowed([], "444444444444444444"), true);
  });
});

describe("memberHasAllowedRole", () => {
  it("allows anyone when the role list is empty", () => {
    assert.equal(memberHasAllowedRole([], null), true);
    assert.equal(memberHasAllowedRole([], ["crew"]), true);
  });

  it("fails closed when roles are configured and the member is missing or unlisted", () => {
    assert.equal(memberHasAllowedRole(["crew"], null), false);
    assert.equal(memberHasAllowedRole(["crew"], ["rando"]), false);
    assert.equal(memberHasAllowedRole(["crew"], ["crew"]), true);
  });
});
