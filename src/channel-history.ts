import { maxHistoryLineChars } from "./constants.ts";
import { extractMessage, flattenMessageText, fromApiMessage, type ApiMessageInput } from "./message-text.ts";
import { redactSecrets } from "./redact.ts";

export type HistoryEntry = {
  id: string;
  authorId: string;
  authorName: string;
  bot: boolean;
  webhook: boolean;
  roleIds: string[];
  /** Note, forwarded messages, embeds, and attachment URLs, flattened by message-text. */
  content: string;
};

/** Readable text for a raw REST message, including forwarded snapshots, embeds, and attachments. */
export function historyContent(message: ApiMessageInput): string {
  return flattenMessageText(extractMessage(fromApiMessage(message)));
}

export function shouldIncludeHistoryMessage(
  allowedRoleIds: string[],
  allowedUserIds: string[],
  currentAuthorId: string,
  botUserId: string | undefined,
  entry: Pick<HistoryEntry, "id" | "authorId" | "bot" | "webhook" | "roleIds">,
  currentMessageId?: string,
): boolean {
  if (currentMessageId && entry.id === currentMessageId) {
    return false;
  }

  if (botUserId && entry.authorId === botUserId) {
    return true;
  }

  if (entry.bot || entry.webhook) {
    return false;
  }

  if (entry.authorId === currentAuthorId || allowedUserIds.includes(entry.authorId)) {
    return true;
  }

  if (allowedRoleIds.length === 0) {
    return false;
  }

  return allowedRoleIds.some((roleId) => entry.roleIds.includes(roleId));
}

export function formatHistoryLine(entry: HistoryEntry): string {
  const body = entry.content.replace(/\s+/g, " ").trim() || "[empty]";
  const clipped = body.length > maxHistoryLineChars ? `${body.slice(0, maxHistoryLineChars)}…` : body;
  return `${entry.authorName}: ${redactSecrets(clipped)}`;
}
