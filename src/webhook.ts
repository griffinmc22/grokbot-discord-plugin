import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";

import { webhookTimeoutMs } from "./constants.ts";
import {
  extractMessage,
  flattenMessageText,
  type ExtractedAttachment,
  type ExtractedEmbed,
  type ExtractedForward,
  type MessageInput,
} from "./message-text.ts";
import { redactSecrets } from "./redact.ts";
import { pinWebhookAddress, type AddressLookup, type PinnedAddress } from "./webhook-url.ts";

export type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

export function invokePinnedLookup(
  pinned: PinnedAddress,
  options: unknown,
  callback?: PinnedLookupCallback,
): void {
  const cb: PinnedLookupCallback =
    typeof options === "function" ? (options as PinnedLookupCallback) : (callback ?? (() => undefined));
  const all = Boolean(
    options && typeof options === "object" && (options as { all?: unknown }).all === true,
  );

  if (all) {
    cb(null, [{ address: pinned.address, family: pinned.family }]);
    return;
  }

  cb(null, pinned.address, pinned.family);
}

export type WebhookPayload = {
  message_id: string;
  /** Channel the message arrived in; the DM channel id for DMs. Reply here. */
  channel_id: string;
  /** Null for DMs. */
  guild_id: string | null;
  /** Parent text channel for guild messages (threads resolve to it); null for DMs. */
  parent_channel_id: string | null;
  is_dm: boolean;
  /** The DM channel id when is_dm, else null. */
  dm_channel_id: string | null;
  author_id: string;
  author_username: string;
  /** The author's own text (clean content) with the bot's @mention stripped. */
  content: string;
  /** The author's own text (clean content) exactly as sent, mention included. */
  content_original: string;
  /** Note + forwarded messages + embeds + attachment URLs as one readable block. */
  content_full: string;
  is_forward: boolean;
  forwarded: ExtractedForward[];
  embeds: ExtractedEmbed[];
  attachments: ExtractedAttachment[];
  is_reply: boolean;
  referenced_message_id: string | null;
};

export type WebhookPayloadSource = {
  messageId: string;
  channelId: string;
  guildId: string | null;
  parentChannelId: string | null;
  isDm: boolean;
  authorId: string;
  authorUsername: string;
  /** Clean content with the bot's mention removed. */
  content: string;
  /** Clean content as sent. */
  contentOriginal: string;
  /** Embeds, attachments, and forwarded snapshots; its content should be `content`. */
  message: MessageInput;
  isReply: boolean;
  referencedMessageId: string | null;
};

export function buildWebhookPayload(source: WebhookPayloadSource): WebhookPayload {
  const extracted = extractMessage({ ...source.message, content: source.content });
  return {
    message_id: source.messageId,
    channel_id: source.channelId,
    guild_id: source.isDm ? null : source.guildId,
    parent_channel_id: source.isDm ? null : source.parentChannelId,
    is_dm: source.isDm,
    dm_channel_id: source.isDm ? source.channelId : null,
    author_id: source.authorId,
    author_username: source.authorUsername,
    content: source.content,
    content_original: source.contentOriginal,
    content_full: flattenMessageText(extracted),
    is_forward: extracted.forwarded.length > 0,
    forwarded: extracted.forwarded,
    embeds: extracted.embeds,
    attachments: extracted.attachments,
    is_reply: source.isReply,
    referenced_message_id: source.isReply ? source.referencedMessageId : null,
  };
}

export type WebhookDeps = {
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
};

export function signWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function webhookHeaders(body: string, secret?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (!secret) {
    return headers;
  }

  headers["x-grok-signature"] = `sha256=${signWebhookBody(body, secret)}`;
  headers.authorization = `Bearer ${secret}`;
  return headers;
}

function redactNullable(value: string | null): string | null {
  return value === null ? null : redactSecrets(value);
}

function sanitizeEmbed(embed: ExtractedEmbed): ExtractedEmbed {
  return {
    title: redactNullable(embed.title),
    description: redactNullable(embed.description),
    url: redactNullable(embed.url),
    author: redactNullable(embed.author),
    author_url: redactNullable(embed.author_url),
    footer: redactNullable(embed.footer),
    fields: embed.fields.map((field) => ({ name: redactSecrets(field.name), value: redactSecrets(field.value) })),
  };
}

function sanitizeAttachment(attachment: ExtractedAttachment): ExtractedAttachment {
  return { ...attachment, name: redactNullable(attachment.name), url: redactSecrets(attachment.url) };
}

function sanitizeForward(forward: ExtractedForward): ExtractedForward {
  return {
    content: redactSecrets(forward.content),
    embeds: forward.embeds.map(sanitizeEmbed),
    attachments: forward.attachments.map(sanitizeAttachment),
  };
}

export function sanitizeWebhookPayload(payload: WebhookPayload): WebhookPayload {
  return {
    ...payload,
    author_username: redactSecrets(payload.author_username),
    content: redactSecrets(payload.content),
    content_original: redactSecrets(payload.content_original),
    content_full: redactSecrets(payload.content_full),
    forwarded: payload.forwarded.map(sanitizeForward),
    embeds: payload.embeds.map(sanitizeEmbed),
    attachments: payload.attachments.map(sanitizeAttachment),
  };
}

function postPinnedJson(
  url: string,
  pinned: PinnedAddress,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number }> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const client = isHttps ? https : http;
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup(_hostname, options, callback) {
          invokePinnedLookup(pinned, options, callback);
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0 });
        });
      },
    );

    req.setTimeout(webhookTimeoutMs, () => {
      req.destroy();
      reject(new Error("webhook timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function postGrokWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string,
  deps: WebhookDeps = {},
): Promise<void> {
  if (!secret) {
    throw new Error("GROK_WEBHOOK_SECRET is required when GROK_WEBHOOK_URL is set");
  }

  const pinned = await pinWebhookAddress(url, deps.lookup);
  const body = JSON.stringify(sanitizeWebhookPayload(payload));
  const headers = webhookHeaders(body, secret);

  if (deps.fetchImpl) {
    const response = await deps.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(webhookTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`webhook ${response.status}`);
    }

    return;
  }

  const response = await postPinnedJson(url, pinned, headers, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`webhook ${response.status}`);
  }
}
