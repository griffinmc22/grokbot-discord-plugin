# Discord intake bridge

Forward any Discord message into a private `#inbox` channel, add a short note ("add to calendar", "research this"), and your Grok Bot handles it: it adds Google Calendar events or does the research, then confirms with a reply in `#inbox`.

```
any Discord message ──Forward──▶ #inbox (+ your note)
                                    │  gateway worker (this repo), intake mode
                                    ▼
                     POST JSON ──▶ Grok Bot webhook routine
                                    │  Google Calendar / research
                                    ▼
                     discord_reply ──▶ confirmation under your message in #inbox
```

Intake mode is the default (`DISCORD_INTAKE_MODE=true`). Every message from an allowed user in an allowlisted channel goes to the routine. You don't need to @mention the bot, use its name, or reply to it. Messages from anyone not in `DISCORD_ALLOWED_USER_IDS` are ignored, and the worker refuses to start if that list is empty.

## 1. Create the Discord application and bot

1. Open [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a password and never paste it in Discord or chat.
3. Under **Privileged Gateway Intents**, turn **Message Content Intent** on. Without it, forwarded content and your notes arrive empty.
4. Leave **Server Members Intent** and **Presence Intent** off. The gateway doesn't request either. Even optional role checks use the member data Discord sends with each message.
5. Save.

## 2. Invite the bot

1. **OAuth2** → **URL Generator** → scope **bot** only.
2. Bot permissions: **View Channels**, **Send Messages**, **Read Message History**. Add **Add Reactions** only if your routine uses `discord_react`. Never grant Administrator.
3. Open the generated URL and add the bot to your server.

## 3. Make a private `#inbox` channel

1. Create a text channel, e.g. `#inbox`. In **Permissions**, make it private (deny `@everyone` View Channel).
2. Add **yourself** and the **bot's own role** with View Channel, Send Messages, and Read Message History as channel overrides. Discord returns 50013 Missing Permissions if the bot only gets these through a server-wide role.

## 4. Collect IDs (Developer Mode)

Turn on **User Settings → Advanced → Developer Mode**, then:

| Right-click | Copy | Env var |
| --- | --- | --- |
| Server name | Server ID | `DISCORD_GUILD_ID` |
| `#inbox` | Channel ID | `DISCORD_CHANNEL_IDS` (comma-separate if more than one) |
| Your own name/avatar | User ID | `DISCORD_ALLOWED_USER_IDS` (comma-separate to allow more people) |

## 5. Create the webhook routine in Grok Bot

Create a webhook routine in the Grok Bot app, copy its webhook URL and key from the routine panel into `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET`.

The routine needs the `grok-discord` MCP tools (from this plugin) so it can reply, plus your Google Calendar connector and web search for research. Paste the prompt from [Suggested routine prompt](#suggested-routine-prompt) into the routine.

## 6. Environment variables

| Variable | Required | Value |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token (step 1). Secret. |
| `DISCORD_GUILD_ID` | yes | Server ID |
| `DISCORD_CHANNEL_IDS` | yes | `#inbox` channel ID(s) |
| `DISCORD_ALLOWED_USER_IDS` | yes | Your Discord user ID(s). Required in intake mode. |
| `GROK_WEBHOOK_URL` | yes | Webhook URL from the routine panel (public HTTPS) |
| `GROK_WEBHOOK_SECRET` | yes | Webhook key from the routine panel. Secret. |
| `DISCORD_INTAKE_MODE` | no | Default `true`. `false` = mention/name-driven chat mode. |
| `DISCORD_ALLOWED_ROLE_IDS` | no | Extra role check on top of the user allowlist |

Put them in `.env` in the plugin root (it is git-ignored; see `.env.example`) or in the Grok Bot launch-wrapper env. Never commit them.

## 7. Run

```bash
npm ci
npm run build
bash ./bin/with-env.sh node dist/cli.js ensure   # start one supervised gateway worker
bash ./bin/with-env.sh node dist/cli.js status   # is it running?
bash ./bin/with-env.sh node dist/cli.js restart  # after changing env
```

For a foreground run while debugging, use `bash ./bin/with-env.sh node dist/cli.js gateway`. From Grok Bot itself you can use the MCP tools `discord_ensure_worker` and `discord_restart_worker` instead. Run one gateway per bot token.

Expected log lines (`~/.grok-discord/worker-*.log`):

```
grok-discord ready as YourBot#1234; one replica per bot token
grok-discord intake mode: every message from 1 allowed user(s) in 1 channel(s) is forwarded
```

In `#inbox`, `/status` replies "Yeah, I'm here. Gateway up." and `/new` resets the follow-up window. Both are handled by the gateway without calling the routine. In intake mode only the exact slash commands count, and never on a forwarded message.

## Payload

Each message is POSTed as JSON with `Authorization: Bearer <GROK_WEBHOOK_SECRET>` and `X-Grok-Signature: sha256=<HMAC-SHA256 of the body>`:

```json
{
  "message_id": "1300000000000000001",
  "channel_id": "1200000000000000001",
  "guild_id": "1100000000000000001",
  "parent_channel_id": "1200000000000000001",
  "author_id": "1000000000000000001",
  "author_username": "you",
  "content": "add to calendar",
  "content_full": "add to calendar\n\n[Forwarded message]\nBook club Thursday 6pm at the library\n[Embed] Book club — https://example.com/club\nRoom 2\n[Attachment] flyer.png (image/png, 2048 bytes): https://cdn.discordapp.com/attachments/.../flyer.png",
  "is_forward": true,
  "forwarded": [
    {
      "content": "Book club Thursday 6pm at the library",
      "embeds": [
        {
          "title": "Book club",
          "description": "Room 2",
          "url": "https://example.com/club",
          "author": null,
          "author_url": null,
          "footer": null,
          "fields": []
        }
      ],
      "attachments": [
        { "name": "flyer.png", "url": "https://cdn.discordapp.com/attachments/.../flyer.png", "content_type": "image/png", "size": 2048 }
      ]
    }
  ],
  "embeds": [],
  "attachments": [],
  "is_reply": false,
  "referenced_message_id": null
}
```

- `content` is your own note only (kept for backward compatibility).
- `content_full` is your note followed by every forwarded message, embed, and attachment URL as plain text. Most routines only need this field.
- `forwarded`, `embeds`, and `attachments` are the same data in structured form. `embeds` and `attachments` belong to your own message; anything inside a forward is under `forwarded[]`.
- Obvious secrets (tokens, keys) are redacted before sending.

`discord_history` uses the same extraction, so earlier forwarded items appear in history with their text, embeds, and attachment URLs.

## Suggested routine prompt

```
You process items the user drops into their private Discord #inbox.
Use the grok-discord MCP tools to reply. Do not open a Discord Gateway,
start threads, or echo tokens, webhook keys, or env values.

The JSON body has: message_id, channel_id, parent_channel_id, author_id,
content (the user's note), content_full (note + forwarded messages +
embeds + attachment URLs), is_forward, forwarded, embeds, attachments.

1. Read content_full. The user's note (content) says what they want. The
   forwarded text, embeds, and attachments are the material. If the note
   is empty, infer the intent: event-like material (date, time, place) ->
   calendar; otherwise -> research summary.
2. Calendar: extract each event (title, date, start/end time, timezone,
   location, link). Use the user's timezone if none is given. Assume
   1 hour if there is no end time. Add the event(s) to Google Calendar.
   If a key detail like the date is missing or ambiguous, do not guess:
   ask one short question instead.
3. Research: look the topic up, then write a short answer: 3-6 bullets
   with source links.
4. Reply with discord_reply using message_id, channel_id, and author_id
   from the body. Confirm what you did, e.g. "Added: Book club, Thu
   Nov 6, 6-7pm, Library room 2" plus the event link, or the research
   bullets. Keep it under ~1500 characters.
5. If something fails, reply with one plain sentence saying what failed.
   Never post stack traces or secrets.
```
