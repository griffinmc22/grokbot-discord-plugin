import { channelIsAllowed } from "./allowlist.ts";

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
  /** Intake channel: every message that passed shouldHandle and the user allowlist is for the bot. */
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
  if (input.intakeMode || input.mentionedBot || input.isReplyToBot) {
    return true;
  }

  if (namesBot(input.content, input.botNames)) {
    return true;
  }

  return input.followUp;
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
