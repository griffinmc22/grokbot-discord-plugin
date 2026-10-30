export type AllowlistConfig = {
  discordGuildId: string;
  discordChannelIds: string[];
  discordCategoryIds?: string[];
};

/**
 * A parent text channel is allowed when it is listed itself, or when its
 * category (the channel's own parent_id) is listed. Threads pass their parent
 * channel and that parent's category.
 */
export function channelIsAllowed(
  config: AllowlistConfig,
  guildId: string | null | undefined,
  parentChannelId: string | null | undefined,
  categoryId?: string | null,
): boolean {
  if (!guildId || !parentChannelId || guildId !== config.discordGuildId) {
    return false;
  }

  if (config.discordChannelIds.includes(parentChannelId)) {
    return true;
  }

  return Boolean(categoryId && (config.discordCategoryIds ?? []).includes(categoryId));
}

export function assertChannelAllowed(
  config: AllowlistConfig,
  guildId: string | null | undefined,
  parentChannelId: string | null | undefined,
  categoryId?: string | null,
): void {
  if (!channelIsAllowed(config, guildId, parentChannelId, categoryId)) {
    throw new Error("Channel is outside the configured Discord allowlist.");
  }
}
