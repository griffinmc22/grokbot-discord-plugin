import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWebhookPayload,
  invokePinnedLookup,
  postGrokWebhook,
  sanitizeWebhookPayload,
  signWebhookBody,
  webhookHeaders,
} from "./webhook.ts";

describe("webhook HMAC", () => {
  it("signs the body when a secret is set", () => {
    const body = JSON.stringify({ message_id: "1" });
    const headers = webhookHeaders(body, "s3cret");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["x-grok-signature"], `sha256=${signWebhookBody(body, "s3cret")}`);
    assert.equal(headers.authorization, "Bearer s3cret");
    assert.equal(signWebhookBody(body, "s3cret"), signWebhookBody(body, "s3cret"));
    assert.notEqual(signWebhookBody(body, "s3cret"), signWebhookBody(body, "other"));
  });

  it("omits signature headers when no secret is set", () => {
    const headers = webhookHeaders("{}", undefined);
    assert.equal(headers["x-grok-signature"], undefined);
    assert.equal(headers.authorization, undefined);
  });
});

describe("buildWebhookPayload", () => {
  const base = {
    messageId: "1300000000000000001",
    authorId: "1000000000000000001",
    authorUsername: "you",
    content: "add dentist tuesday 3pm",
    contentOriginal: "@Grok add dentist tuesday 3pm",
    message: {
      snapshots: [{ content: "Dentist moved to Tue 3pm", embeds: [], attachments: [] }],
    },
    isReply: false,
    referencedMessageId: null,
  };

  it("marks DMs: is_dm, dm_channel_id = channel_id, null guild and parent", () => {
    const payload = buildWebhookPayload({
      ...base,
      channelId: "1400000000000000001",
      guildId: null,
      parentChannelId: "1400000000000000001",
      isDm: true,
    });

    assert.equal(payload.is_dm, true);
    assert.equal(payload.channel_id, "1400000000000000001");
    assert.equal(payload.dm_channel_id, "1400000000000000001");
    assert.equal(payload.guild_id, null);
    assert.equal(payload.parent_channel_id, null);
    assert.equal(payload.is_forward, true);
    assert.equal(payload.content_full, "add dentist tuesday 3pm\n\n[Forwarded message]\nDentist moved to Tue 3pm");
  });

  it("keeps guild fields, the mention-stripped content, and the original for channel messages", () => {
    const payload = buildWebhookPayload({
      ...base,
      channelId: "1200000000000000002",
      guildId: "1100000000000000001",
      parentChannelId: "1200000000000000001",
      isDm: false,
      isReply: true,
      referencedMessageId: "1300000000000000000",
    });

    assert.equal(payload.is_dm, false);
    assert.equal(payload.dm_channel_id, null);
    assert.equal(payload.guild_id, "1100000000000000001");
    assert.equal(payload.parent_channel_id, "1200000000000000001");
    assert.equal(payload.channel_id, "1200000000000000002");
    assert.equal(payload.content, "add dentist tuesday 3pm");
    assert.equal(payload.content_original, "@Grok add dentist tuesday 3pm");
    assert.equal(payload.is_reply, true);
    assert.equal(payload.referenced_message_id, "1300000000000000000");
  });
});

describe("postGrokWebhook", () => {
  const payload = {
    message_id: "1",
    channel_id: "2",
    guild_id: "3",
    parent_channel_id: "2",
    is_dm: false,
    dm_channel_id: null,
    author_id: "4",
    author_username: "ada",
    content: "hello ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    content_original: "@Grok hello ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    content_full: "hello ghp_abcdefghijklmnopqrstuvwxyz1234567890\n\n[Forwarded message]\nkey ghp_abcdefghijklmnopqrstuvwxyz0987654321",
    is_forward: true,
    forwarded: [
      {
        content: "key ghp_abcdefghijklmnopqrstuvwxyz0987654321",
        embeds: [
          {
            title: null,
            description: "token ghp_abcdefghijklmnopqrstuvwxyz1111111111",
            url: null,
            author: null,
            author_url: null,
            footer: null,
            fields: [],
          },
        ],
        attachments: [],
      },
    ],
    embeds: [],
    attachments: [],
    is_reply: false,
    referenced_message_id: null,
  };

  it("redacts secrets in the posted body", () => {
    const sanitized = sanitizeWebhookPayload(payload);
    assert.equal(sanitized.content.includes("ghp_"), false);
    assert.match(sanitized.content, /\[redacted\]/);
    assert.equal(JSON.stringify(sanitized).includes("ghp_"), false);
  });

  it("refuses to POST without a secret", async () => {
    await assert.rejects(postGrokWebhook("https://hooks.example.com/grok", payload), /GROK_WEBHOOK_SECRET/);
  });

  it("does not follow redirects and posts the signed body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await postGrokWebhook("https://hooks.example.com/grok", payload, "sender-key", {
      async lookup() {
        return [{ address: "8.8.8.8", family: 4 }];
      },
      async fetchImpl(url, init) {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init.redirect, "error");
    assert.equal(calls[0]?.init.method, "POST");
    const body = String(calls[0]?.init.body);
    assert.equal(body.includes("ghp_"), false);
    assert.match(String((calls[0]?.init.headers as Record<string, string>)["x-grok-signature"]), /^sha256=/);
  });
});

describe("invokePinnedLookup", () => {
  const pinned = { hostname: "hooks.example.com", address: "8.8.8.8", family: 4 };

  it("returns an address array when options.all is true", () => {
    let args: unknown[] = [];
    invokePinnedLookup(pinned, { all: true }, (...received) => {
      args = received;
    });

    assert.equal(args[0], null);
    assert.deepEqual(args[1], [{ address: "8.8.8.8", family: 4 }]);
    assert.equal(args.length, 2);
  });

  it("uses the legacy (address, family) callback when all is not set", () => {
    let address: unknown;
    let family: unknown;
    invokePinnedLookup(pinned, {}, (err, addr, fam) => {
      assert.equal(err, null);
      address = addr;
      family = fam;
    });

    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
});
