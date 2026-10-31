import { channelIsAllowed, dmIsAllowed } from "./allowlist.ts";

export type HandleInput = {
  authorIsBot: boolean;
  webhookId?: string | null;
  guildId?: string | null;
  parentChannelId?: string | null;
  /** Category of the parent channel (the parent channel's own parentId), if any. */
  categoryId?: string | null;
  configuredGuildId: string;
  configuredChannelIds: string[];
  configuredCategoryIds?: string[];
  /** Direct message to the bot (no guild). Bypasses guild/channel allowlists; requires an allowed user. */
  isDm?: boolean;
  authorId?: string;
  allowedUserIds?: string[];
  dmIntake?: boolean;
};

export function parentChannelId(channelId: string, threadParentId?: string | null): string | null {
  if (threadParentId === undefined) {
    return channelId;
  }

  if (threadParentId === null) {
    return null;
  }

  return threadParentId;
}

export function shouldHandle(input: HandleInput): boolean {
  if (input.authorIsBot || input.webhookId) {
    return false;
  }

  if (input.isDm) {
    return Boolean(
      input.authorId &&
        dmIsAllowed(
          {
            discordGuildId: input.configuredGuildId,
            discordChannelIds: input.configuredChannelIds,
            discordAllowedUserIds: input.allowedUserIds,
            dmIntake: input.dmIntake,
          },
          [input.authorId],
        ),
    );
  }

  return channelIsAllowed(
    {
      discordGuildId: input.configuredGuildId,
      discordChannelIds: input.configuredChannelIds,
      discordCategoryIds: input.configuredCategoryIds,
    },
    input.guildId,
    input.parentChannelId,
    input.categoryId,
  );
}

export type DirectedInput = {
  /** A DM that passed shouldHandle: always for the bot. */
  isDm?: boolean;
  /** Intake mode: in guild channels only a real @mention or a reply to the bot counts. */
  intakeMode?: boolean;
  mentionedBot: boolean;
  isReplyToBot: boolean;
  content: string;
  botNames: string[];
  followUp: boolean;
};

export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim();
}

export function namesBot(text: string, botNames: string[]): boolean {
  const unique = [...new Set(botNames.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return false;
  }

  let cleaned = stripMentions(text);

  for (const name of unique) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`@${escaped}`, "gi"), "").trim();
  }

  for (const name of unique) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(cleaned)) {
      return true;
    }
  }

  return false;
}

export function isDirectedAtBot(input: DirectedInput): boolean {
  if (input.isDm) {
    return true;
  }

  if (input.mentionedBot || input.isReplyToBot) {
    return true;
  }

  // Intake mode never guesses from names or open follow-up windows.
  if (input.intakeMode) {
    return false;
  }

  if (namesBot(input.content, input.botNames)) {
    return true;
  }

  return input.followUp;
}

export type MentionInput = {
  /** User IDs mentioned with <@id> / <@!id> (not @everyone, not reply pings). */
  mentionedUserIds: readonly string[];
  /** Mentioned roles with their managing bot id, if the role is a bot's managed role. */
  mentionedRoles: readonly { id: string; botId?: string | null }[];
};

/** True for a direct user mention of the bot or a mention of the bot's own managed role. */
export function mentionsBot(input: MentionInput, botUserId: string | null | undefined): boolean {
  if (!botUserId) {
    return false;
  }

  return input.mentionedUserIds.includes(botUserId) || input.mentionedRoles.some((role) => role.botId === botUserId);
}

/** Remove the bot's own mention tokens (<@id>, <@!id>, its managed <@&role>) from raw message content. */
export function stripBotMentions(raw: string, botUserId: string, botRoleIds: readonly string[] = []): string {
  const ids = [botUserId, ...botRoleIds].map((id) => id.replace(/\D/g, "")).filter(Boolean);
  let text = raw;
  for (const id of ids) {
    text = text.replace(new RegExp(`<@[!&]?${id}>`, "g"), "");
  }

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
}

export function conversationKey(parentChannelId: string, authorId: string): string {
  return `channel:${parentChannelId}:user:${authorId}`;
}

export function userIsAllowed(allowedUserIds: string[], authorId: string): boolean {
  if (allowedUserIds.length === 0) {
    return true;
  }

  return allowedUserIds.includes(authorId);
}

export function memberHasAllowedRole(
  allowedRoleIds: string[],
  memberRoleIds: string[] | null | undefined,
): boolean {
  if (allowedRoleIds.length === 0) {
    return true;
  }

  if (!memberRoleIds) {
    return false;
  }

  return allowedRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}
