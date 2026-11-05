import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractMessage, flattenMessageText, fromApiMessage } from "./message-text.ts";

describe("extractMessage", () => {
  it("keeps a plain message as content with no forwards", () => {
    const extracted = extractMessage({ content: "  dinner friday 7pm  " });

    assert.deepEqual(extracted, { content: "dinner friday 7pm", embeds: [], attachments: [], forwarded: [] });
    assert.equal(flattenMessageText(extracted), "dinner friday 7pm");
  });

  it("extracts a forwarded snapshot with embeds and attachments under the user's note", () => {
    const extracted = extractMessage({
      content: "add this to my calendar",
      snapshots: [
        {
          content: "Team offsite is Nov 12 at 10am",
          embeds: [
            {
              title: "Offsite agenda",
              url: "https://example.com/agenda",
              description: "Bring laptops",
              author: { name: "Ops", url: "https://example.com/ops" },
              footer: { text: "Posted by ops" },
              fields: [{ name: "Location", value: "HQ Room 4" }],
            },
          ],
          attachments: [
            { name: "invite.ics", url: "https://cdn.example.com/invite.ics", contentType: "text/calendar", size: 812 },
          ],
        },
      ],
    });

    assert.equal(extracted.content, "add this to my calendar");
    assert.equal(extracted.forwarded.length, 1);
    assert.deepEqual(extracted.forwarded[0]?.embeds[0], {
      title: "Offsite agenda",
      description: "Bring laptops",
      url: "https://example.com/agenda",
      author: "Ops",
      author_url: "https://example.com/ops",
      footer: "Posted by ops",
      fields: [{ name: "Location", value: "HQ Room 4" }],
    });
    assert.deepEqual(extracted.forwarded[0]?.attachments, [
      { name: "invite.ics", url: "https://cdn.example.com/invite.ics", content_type: "text/calendar", size: 812 },
    ]);

    assert.equal(
      flattenMessageText(extracted),
      [
        "add this to my calendar",
        "",
        "[Forwarded message]",
        "Team offsite is Nov 12 at 10am",
        "[Embed] Offsite agenda — https://example.com/agenda",
        "Author: Ops (https://example.com/ops)",
        "Bring laptops",
        "Location: HQ Room 4",
        "Footer: Posted by ops",
        "[Attachment] invite.ics (text/calendar, 812 bytes): https://cdn.example.com/invite.ics",
      ].join("\n"),
    );
  });

  it("reads an embed-only message (link preview) with no text", () => {
    const extracted = extractMessage({
      content: "",
      embeds: [{ title: "Concert tickets", description: "Doors at 8", url: null, fields: null }],
    });

    assert.equal(extracted.content, "");
    assert.equal(flattenMessageText(extracted), "[Embed] Concert tickets\nDoors at 8");
  });

  it("numbers multiple forwards and marks empty ones", () => {
    const flat = flattenMessageText(extractMessage({ snapshots: [{ content: "one" }, { content: "" }] }));
    assert.equal(flat, "[Forwarded message 1]\none\n\n[Forwarded message 2]\n[empty]");
  });
});

describe("fromApiMessage", () => {
  it("maps REST message_snapshots, embeds, and attachments", () => {
    const flat = flattenMessageText(
      extractMessage(
        fromApiMessage({
          content: "research this",
          attachments: [{ filename: "a.png", url: "https://cdn.example.com/a.png", content_type: "image/png", size: 5 }],
          message_snapshots: [
            {
              message: {
                content: "New café opening on 5th",
                embeds: [{ title: "Menu", fields: [{ name: "Price", value: "$$" }] }],
                attachments: [],
              },
            },
          ],
        }),
      ),
    );

    assert.equal(
      flat,
      [
        "research this",
        "[Attachment] a.png (image/png, 5 bytes): https://cdn.example.com/a.png",
        "",
        "[Forwarded message]",
        "New café opening on 5th",
        "[Embed] Menu",
        "Price: $$",
      ].join("\n"),
    );
  });
});
