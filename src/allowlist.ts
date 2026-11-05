export type AllowlistConfig = {
  discordGuildId: string;
  discordChannelIds: string[];
  discordCategoryIds?: string[];
  /** Needed for DMs: a DM channel is allowed only if one of its recipients is listed. */
  discordAllowedUserIds?: string[];
  /** DMs are in scope only when this is not false. */
  dmIntake?: boolean;
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

/**
 * A DM channel is allowed when DM intake is on and one of its recipients is an
 * allowed user. Fails closed when the user allowlist is empty.
 */
export function dmIsAllowed(config: AllowlistConfig, recipientIds: readonly string[] | null | undefined): boolean {
  const allowed = config.discordAllowedUserIds ?? [];
  if (config.dmIntake === false || allowed.length === 0 || !recipientIds) {
    return false;
  }

  return recipientIds.some((id) => allowed.includes(id));
}

export type ChannelScope = {
  guildId: string | null | undefined;
  parentChannelId: string | null | undefined;
  categoryId?: string | null;
  /** Set for DM channels (the DM's recipients); guild fields are then ignored. */
  dmRecipientIds?: readonly string[] | null;
};

export function scopeIsAllowed(config: AllowlistConfig, scope: ChannelScope): boolean {
  if (scope.dmRecipientIds) {
    return dmIsAllowed(config, scope.dmRecipientIds);
  }

  return channelIsAllowed(config, scope.guildId, scope.parentChannelId, scope.categoryId);
}

export function assertChannelAllowed(
  config: AllowlistConfig,
  guildId: string | null | undefined,
  parentChannelId: string | null | undefined,
  categoryId?: string | null,
  dmRecipientIds?: readonly string[] | null,
): void {
  if (!scopeIsAllowed(config, { guildId, parentChannelId, categoryId, dmRecipientIds })) {
    throw new Error("Channel is outside the configured Discord allowlist.");
  }
}
