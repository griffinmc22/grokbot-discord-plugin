import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  MessageReferenceType,
  Partials,
  cleanContent,
  type DMChannel,
  type GuildTextBasedChannel,
  type PartialMessage,
} from "discord.js";

import {
  addReaction,
  markFailed,
  reactionKey,
  stderrReactionLogger,
  type RemovableReactable,
} from "./ack.ts";
import type { ConnectorConfig } from "./config.ts";
import { followUpWindowMs, publicError } from "./constants.ts";
import {
  conversationKey,
  isDirectedAtBot,
  memberHasAllowedRole,
  mentionsBot,
  shouldHandle,
  stripBotMentions,
  userIsAllowed,
} from "./filters.ts";
import { createFileFollowUpStore } from "./follow-up.ts";
import type { MessageInput } from "./message-text.ts";
import { createChannelMutex } from "./mutex.ts";
import { deliverOutbound } from "./outbound.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { parseRoomCommand } from "./room-commands.ts";
import { defaultRuntimeDir, tokenFingerprint } from "./supervisor.ts";
import { buildWebhookPayload, postGrokWebhook } from "./webhook.ts";

function parentChannelIdFromMessage(message: Message): string | null {
  const { channel } = message;
  if (channel.isThread()) {
    return channel.parentId;
  }
  return channel.id;
}

function isSendableParent(channel: unknown): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object" || !("type" in channel)) {
    return false;
  }

  const type = (channel as { type: ChannelType }).type;
  return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;
}

async function homeChannel(message: Message): Promise<GuildTextBasedChannel> {
  if (message.channel.isThread()) {
    let parent: GuildTextBasedChannel | null = isSendableParent(message.channel.parent)
      ? message.channel.parent
      : null;

    if (!parent && message.channel.parentId) {
      const fetched = await message.client.channels.fetch(message.channel.parentId);
      if (isSendableParent(fetched)) {
        parent = fetched;
      }
    }

    if (!parent) {
      throw new Error("Cannot find the parent channel for this thread");
    }

    return parent;
  }

  if (!isSendableParent(message.channel)) {
    throw new Error("Only server text channels are allowed");
  }

  return message.channel;
}

/**
 * Category of the message's parent text channel (for a thread, the thread's
 * parent channel's parentId). Only looked up when DISCORD_CATEGORY_IDS is set
 * and the channel is not already allowlisted directly; null when the parent
 * is not a server text channel, so voice-channel chat and forum posts stay out.
 */
async function categoryIdFor(
  config: ConnectorConfig,
  message: Message,
  parentId: string | null,
): Promise<string | null> {
  if (
    config.discordCategoryIds.length === 0 ||
    message.author.bot ||
    message.webhookId ||
    message.guildId !== config.discordGuildId ||
    !parentId ||
    config.discordChannelIds.includes(parentId)
  ) {
    return null;
  }

  try {
    return (await homeChannel(message)).parentId ?? null;
  } catch {
    return null;
  }
}

function messageInput(message: Message): MessageInput {
  return {
    content: message.cleanContent,
    embeds: message.embeds,
    attachments: [...message.attachments.values()],
    snapshots: [...message.messageSnapshots.values()].map((snapshot) => ({
      content: snapshot.content,
      embeds: snapshot.embeds,
      attachments: [...snapshot.attachments.values()],
    })),
  };
}

function isDmMessage(message: Message): boolean {
  return !message.guildId && message.channel.type === ChannelType.DM;
}

/** A forward also carries a message reference; only a real reply counts as one. */
function replyReferenceId(message: Message): string | null {
  const reference = message.reference;
  if (!reference?.messageId || reference.type === MessageReferenceType.Forward) {
    return null;
  }
  return reference.messageId;
}

function botNamesFor(config: ConnectorConfig, client: Client): string[] {
  const names = [config.botNamePrefix, client.user?.username, client.user?.globalName];
  return [...new Set(names.filter((name): name is string => Boolean(name && name.trim())))];
}

function botRoleIdsMentioned(client: Client, message: Message): string[] {
  const botId = client.user?.id;
  if (!botId) {
    return [];
  }
  return [...message.mentions.roles.values()].filter((role) => role.tags?.botId === botId).map((role) => role.id);
}

function mentionedBot(client: Client, message: Message): boolean {
  return mentionsBot(
    {
      mentionedUserIds: [...message.mentions.users.keys()],
      mentionedRoles: [...message.mentions.roles.values()].map((role) => ({ id: role.id, botId: role.tags?.botId })),
    },
    client.user?.id,
  );
}

async function isReplyToBot(client: Client, message: Message): Promise<boolean> {
  if (!client.user) {
    return false;
  }

  const refId = replyReferenceId(message);
  if (!refId) {
    return false;
  }

  if (message.mentions.repliedUser?.id === client.user.id) {
    return true;
  }

  if (!("messages" in message.channel)) {
    return false;
  }

  const referenced =
    message.channel.messages.cache.get(refId) ??
    (await message.channel.messages.fetch(refId).catch(() => null));

  return referenced?.author.id === client.user.id;
}

/** Clean content without the bot's own mention, so "@Bot add dentist" reaches the routine as "add dentist". */
function contentWithoutBotMention(client: Client, message: Message): string {
  const botId = client.user?.id;
  if (!botId) {
    return message.cleanContent;
  }
  return cleanContent(stripBotMentions(message.content, botId, botRoleIdsMentioned(client, message)), message.channel);
}

async function speak(
  config: ConnectorConfig,
  message: Message,
  text: string,
  replyTo = true,
): Promise<void> {
  if (isDmMessage(message)) {
    const dm = message.channel as DMChannel;
    await deliverOutbound({
      config,
      guildId: null,
      parentChannelId: dm.id,
      dmRecipientIds: [dm.recipientId ?? message.author.id],
      inThread: false,
      replyToMessageId: replyTo ? message.id : undefined,
      text,
      async post(chunk, mode) {
        if (mode === "reply") {
          await message.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
          return;
        }
        await dm.send({ content: chunk, allowedMentions: { parse: [] } });
      },
    });
    return;
  }

  const parentId = parentChannelIdFromMessage(message);
  const home = await homeChannel(message);
  const inThread = message.channel.isThread();

  await deliverOutbound({
    config,
    guildId: message.guildId,
    parentChannelId: parentId,
    categoryId: home.parentId,
    inThread,
    replyToMessageId: replyTo ? message.id : undefined,
    text,
    async post(chunk, mode) {
      if (mode === "reply") {
        await message.reply({
          content: chunk,
          allowedMentions: { parse: [], repliedUser: false },
        });
        return;
      }

      await home.send({ content: chunk, allowedMentions: { parse: [] } });
    },
  });
}

function reactionTarget(client: Client, message: Message): RemovableReactable {
  return {
    react: (emoji) => message.react(emoji),
    async removeOwnReaction(emoji) {
      const botId = client.user?.id;
      if (botId) {
        await message.reactions.resolve(reactionKey(emoji))?.users.remove(botId);
      }
    },
  };
}

/** Partial messages (enabled for DMs) carry no content until fetched. */
async function completeMessage(incoming: Message | PartialMessage): Promise<Message | null> {
  if (!incoming.partial) {
    return incoming;
  }

  try {
    return (await incoming.fetch()) as Message;
  } catch {
    return null;
  }
}

export async function startDiscordGateway(config: ConnectorConfig): Promise<Client> {
  const followUps = createFileFollowUpStore(
    defaultRuntimeDir(),
    tokenFingerprint(config.discordToken),
    followUpWindowMs,
  );
  const mutex = createChannelMutex();
  const userRate = createRateLimiter(config.rateWindowMs, config.ratePerUser);
  const channelRate = createRateLimiter(config.rateWindowMs, config.ratePerChannel);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // DM channels are not cached before their first message; without these partials messageCreate never fires for DMs.
    partials: [Partials.Channel, Partials.Message],
  });

  let booted = false;
  const onReady = () => {
    if (booted) {
      return;
    }
    booted = true;
    const tag = client.user?.tag ?? "unknown";
    process.stdout.write(`grok-discord ready as ${tag}; one replica per bot token\n`);
    process.stdout.write(
      config.intakeMode
        ? `grok-discord intake mode: ${config.discordAllowedUserIds.length} allowed user(s); guild channels (${config.discordChannelIds.length} channel(s), ${config.discordCategoryIds.length} category(ies)) need an @mention or a reply to the bot\n`
        : "grok-discord chat mode: only mentions, replies, bot names, and follow-ups are forwarded\n",
    );
    process.stdout.write(
      config.dmIntake && config.discordAllowedUserIds.length > 0
        ? "grok-discord DM intake on: every DM from an allowed user is forwarded\n"
        : "grok-discord DM intake off: DMs are ignored\n",
    );
    if (!config.grokWebhookUrl) {
      process.stdout.write("grok-discord GROK_WEBHOOK_URL is not set; inbound will not wake a Grok Bot\n");
    }
  };

  client.once("clientReady", onReady);
  client.once("ready", onReady);

  client.on("messageCreate", async (incoming) => {
    const message = await completeMessage(incoming as Message | PartialMessage);
    if (!message) {
      return;
    }

    const isDm = isDmMessage(message);
    const parentId = parentChannelIdFromMessage(message);
    if (
      !shouldHandle({
        authorIsBot: message.author.bot,
        webhookId: message.webhookId,
        guildId: message.guildId,
        parentChannelId: parentId,
        categoryId: isDm ? null : await categoryIdFor(config, message, parentId),
        configuredGuildId: config.discordGuildId,
        configuredChannelIds: config.discordChannelIds,
        configuredCategoryIds: config.discordCategoryIds,
        isDm,
        authorId: message.author.id,
        allowedUserIds: config.discordAllowedUserIds,
        dmIntake: config.dmIntake,
      })
    ) {
      return;
    }

    // DMs scope by their DM channel; guild messages by their parent text channel.
    const scopeId = isDm ? message.channel.id : parentId;
    if (!scopeId) {
      return;
    }

    if (!userIsAllowed(config.discordAllowedUserIds, message.author.id)) {
      return;
    }

    const names = botNamesFor(config, client);
    const sessionKey = conversationKey(scopeId, message.author.id);
    const mentioned = !isDm && mentionedBot(client, message);
    const directed = isDirectedAtBot({
      isDm,
      intakeMode: config.intakeMode,
      mentionedBot: mentioned,
      isReplyToBot: !isDm && !mentioned && (await isReplyToBot(client, message)),
      content: message.cleanContent,
      botNames: names,
      followUp: !config.intakeMode && followUps.isFollowUp(sessionKey),
    });

    if (!directed) {
      return;
    }

    // Roles only exist in the guild; DMs are gated by the user allowlist alone.
    if (!isDm) {
      const member = message.member;
      const roleIds = member ? [...member.roles.cache.keys()] : null;
      if (!memberHasAllowedRole(config.discordAllowedRoleIds, roleIds)) {
        return;
      }
    }

    const content = contentWithoutBotMention(client, message);

    // Rate limit at arrival (not after waiting on the channel mutex), so the ack below is instant
    // and rate-limited drops never get one.
    if (!userRate.allow(message.author.id) || !channelRate.allow(scopeId)) {
      process.stderr.write("grok-discord inbound dropped: rate limited\n");
      return;
    }

    // Fire-and-forget: a slow or failed reaction never delays or blocks forwarding.
    const reactions = reactionTarget(client, message);
    const ackPending = addReaction(reactions, config.ackEmoji, stderrReactionLogger);

    await mutex.run(scopeId, async () => {
      try {
        // In intake mode a forwarded message is always an intake item, whatever the note says.
        const roomCommand =
          config.intakeMode && message.messageSnapshots.size > 0
            ? null
            : parseRoomCommand(content, config.intakeMode ? [] : names, { slashOnly: config.intakeMode });
        if (roomCommand?.kind === "new") {
          followUps.clear(sessionKey);
          await speak(config, message, "Fresh thread. I'm listening.");
          return;
        }

        if (roomCommand?.kind === "status") {
          await speak(config, message, "Yeah, I'm here. Gateway up.");
          return;
        }

        if (!config.grokWebhookUrl) {
          process.stdout.write("grok-discord inbound dropped: GROK_WEBHOOK_URL is not set\n");
          return;
        }

        const replyRef = replyReferenceId(message);
        await postGrokWebhook(
          config.grokWebhookUrl,
          buildWebhookPayload({
            messageId: message.id,
            channelId: message.channel.id,
            guildId: message.guildId,
            parentChannelId: parentId,
            isDm,
            authorId: message.author.id,
            authorUsername: message.author.username,
            content,
            contentOriginal: message.cleanContent,
            message: messageInput(message),
            isReply: Boolean(replyRef),
            referencedMessageId: replyRef,
          }),
          config.grokWebhookSecret,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        process.stderr.write(`grok-discord turn error: ${detail}\n`);
        void markFailed(
          reactions,
          { ackEmoji: config.ackEmoji, errorEmoji: config.errorEmoji, ackPending },
          stderrReactionLogger,
        );
        try {
          await speak(config, message, publicError);
        } catch (speakError) {
          const speakDetail = speakError instanceof Error ? speakError.message : "speak failed";
          process.stderr.write(`grok-discord public error failed: ${speakDetail}\n`);
        }
      }
    });
  });

  await client.login(config.discordToken);
  return client;
}
