// Pure extraction of everything readable in a Discord message: the typed note,
// forwarded message snapshots, embeds, and attachment URLs. Takes structural
// inputs so discord.js objects and raw REST payloads both fit without importing
// discord.js classes here.

export type EmbedInput = {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  author?: { name?: string | null; url?: string | null } | null;
  footer?: { text?: string | null } | null;
  fields?: readonly { name: string; value: string }[] | null;
};

export type AttachmentInput = {
  name?: string | null;
  url: string;
  contentType?: string | null;
  size?: number | null;
};

export type SnapshotInput = {
  content?: string | null;
  embeds?: readonly EmbedInput[] | null;
  attachments?: readonly AttachmentInput[] | null;
};

export type MessageInput = SnapshotInput & {
  snapshots?: readonly SnapshotInput[] | null;
};

export type ExtractedEmbed = {
  title: string | null;
  description: string | null;
  url: string | null;
  author: string | null;
  author_url: string | null;
  footer: string | null;
  fields: { name: string; value: string }[];
};

export type ExtractedAttachment = {
  name: string | null;
  url: string;
  content_type: string | null;
  size: number | null;
};

export type ExtractedForward = {
  content: string;
  embeds: ExtractedEmbed[];
  attachments: ExtractedAttachment[];
};

export type ExtractedMessage = ExtractedForward & {
  forwarded: ExtractedForward[];
};

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function extractEmbed(embed: EmbedInput): ExtractedEmbed {
  return {
    title: text(embed.title),
    description: text(embed.description),
    url: text(embed.url),
    author: text(embed.author?.name),
    author_url: text(embed.author?.url),
    footer: text(embed.footer?.text),
    fields: (embed.fields ?? [])
      .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
      .filter((field) => field.name || field.value),
  };
}

export function extractAttachment(attachment: AttachmentInput): ExtractedAttachment {
  return {
    name: text(attachment.name),
    url: attachment.url,
    content_type: text(attachment.contentType),
    size: typeof attachment.size === "number" ? attachment.size : null,
  };
}

function extractPart(part: SnapshotInput): ExtractedForward {
  return {
    content: part.content?.trim() ?? "",
    embeds: (part.embeds ?? []).map(extractEmbed),
    attachments: (part.attachments ?? []).map(extractAttachment),
  };
}

export function extractMessage(message: MessageInput): ExtractedMessage {
  return {
    ...extractPart(message),
    forwarded: (message.snapshots ?? []).map(extractPart),
  };
}

function embedLines(embed: ExtractedEmbed): string[] {
  const lines: string[] = [];
  const heading = [embed.title, embed.url].filter(Boolean).join(" — ");
  lines.push(heading ? `[Embed] ${heading}` : "[Embed]");
  if (embed.author) {
    lines.push(`Author: ${embed.author}${embed.author_url ? ` (${embed.author_url})` : ""}`);
  }
  if (embed.description) {
    lines.push(embed.description);
  }
  for (const field of embed.fields) {
    lines.push(`${field.name}: ${field.value}`);
  }
  if (embed.footer) {
    lines.push(`Footer: ${embed.footer}`);
  }
  return lines;
}

function attachmentLine(attachment: ExtractedAttachment): string {
  const meta = [attachment.content_type, attachment.size === null ? null : `${attachment.size} bytes`]
    .filter(Boolean)
    .join(", ");
  const label = `${attachment.name ?? "file"}${meta ? ` (${meta})` : ""}`;
  return `[Attachment] ${label}: ${attachment.url}`;
}

function partLines(part: ExtractedForward): string[] {
  const lines: string[] = [];
  if (part.content) {
    lines.push(part.content);
  }
  for (const embed of part.embeds) {
    lines.push(...embedLines(embed));
  }
  for (const attachment of part.attachments) {
    lines.push(attachmentLine(attachment));
  }
  return lines;
}

/**
 * One readable text block: the author's own note first, then each forwarded
 * message, embed, and attachment. Empty string when the message has nothing.
 */
export function flattenMessageText(message: ExtractedMessage): string {
  const blocks: string[] = [];
  const own = partLines(message);
  if (own.length > 0) {
    blocks.push(own.join("\n"));
  }

  message.forwarded.forEach((forward, index) => {
    const label = message.forwarded.length > 1 ? `[Forwarded message ${index + 1}]` : "[Forwarded message]";
    const lines = partLines(forward);
    blocks.push([label, ...(lines.length > 0 ? lines : ["[empty]"])].join("\n"));
  });

  return blocks.join("\n\n");
}

/** Raw Discord REST message shape (subset). Snapshots nest under `message`. */
export type ApiMessagePart = {
  content?: string | null;
  embeds?: readonly {
    title?: string;
    description?: string;
    url?: string;
    author?: { name?: string; url?: string };
    footer?: { text?: string };
    fields?: readonly { name: string; value: string }[];
  }[];
  attachments?: readonly {
    filename?: string;
    url: string;
    content_type?: string;
    size?: number;
  }[];
};

export type ApiMessageInput = ApiMessagePart & {
  message_snapshots?: readonly { message: ApiMessagePart }[];
};

function fromApiPart(part: ApiMessagePart): SnapshotInput {
  return {
    content: part.content,
    embeds: part.embeds ?? [],
    attachments: (part.attachments ?? []).map((file) => ({
      name: file.filename,
      url: file.url,
      contentType: file.content_type,
      size: file.size,
    })),
  };
}

export function fromApiMessage(message: ApiMessageInput): MessageInput {
  return {
    ...fromApiPart(message),
    snapshots: (message.message_snapshots ?? []).map((snapshot) => fromApiPart(snapshot.message)),
  };
}
