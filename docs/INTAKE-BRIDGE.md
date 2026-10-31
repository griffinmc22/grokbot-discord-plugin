# Discord intake bridge

Send your Grok Bot things to handle from Discord. Forward a message to the bot in a **DM** (no mention needed), or **@mention** the bot in a private `#inbox` channel, with a short note like "add to calendar" or "research this". The Grok Bot adds Google Calendar events or does the research, then replies to confirm in the same DM or channel.

```
any Discord message ──Forward──▶ DM to the bot             (every message, no mention)
                     or ───────▶ #inbox: "@Bot add this"   (mention or reply-to-bot only)
                                    │  gateway worker (this repo)
                                    ▼
                     POST JSON ──▶ Grok Bot webhook routine
                                    │  Google Calendar / research
                                    ▼
                     discord_reply ──▶ confirmation in the same DM / channel
```

## Who the bot listens to

Defaults: `DISCORD_INTAKE_MODE=true`, `DISCORD_DM_INTAKE=true`.

| Where | Handled when | Ignored |
| --- | --- | --- |
| **DM to the bot** | Every message from a user in `DISCORD_ALLOWED_USER_IDS`, including forwards, embeds, and attachments. No mention needed. | DMs from anyone else (silently), bots, webhooks. All DMs when `DISCORD_DM_INTAKE=false`. |
| **Guild channel** in `DISCORD_CHANNEL_IDS`, or any text channel (and its threads) in a `DISCORD_CATEGORY_IDS` category | An allowed user **@mentions the bot** (`<@bot>` or the bot's own managed role), or **replies to a bot message**. | Everything else: plain messages, the bot's name typed as text, other users, bots, webhooks, other channels. |

Rules that always apply:

- `DISCORD_ALLOWED_USER_IDS` is required in intake mode. The worker refuses to start without it. Even with intake mode off, DMs are never handled while the list is empty.
- A Discord **forward** is not a reply. Forwarding the bot's own message doesn't count as replying to it.
- The bot's mention is removed from `content` before it's sent, so "@Bot add dentist Tue 3pm" arrives as `add dentist Tue 3pm`. The text as sent is kept in `content_original`.
- `DISCORD_ALLOWED_ROLE_IDS` (optional) adds a role check in guild channels only. DMs are gated by the user allowlist alone.
- Room commands are handled by the gateway without calling the routine: `/status` replies "Yeah, I'm here. Gateway up." and `/new` (or `/reset`) starts fresh. In a DM, type them as is. In a guild channel, mention the bot: `@Bot /status`. Only the exact slash commands count, and never on a forwarded message.
- `DISCORD_INTAKE_MODE=false` switches guild channels back to the legacy chat mode (mention, reply, bot name in text, or a 15-minute follow-up window). DM intake follows `DISCORD_DM_INTAKE` in either mode.

Forwarding into a guild channel: a forward carries no @mention, so in `#inbox` either send the note as `@Bot …` right after the forward, or reply to the forward and mention the bot. The DM route needs neither.

## 1. Create the Discord application and bot

1. Open [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a password and never paste it in Discord or chat.
3. Under **Privileged Gateway Intents**, turn **Message Content Intent** on. Without it, notes and forwarded content in guild channels arrive empty. DMs don't need it, but it does no harm there.
4. Leave **Server Members Intent** and **Presence Intent** off. The gateway doesn't request either.
5. Save.

The gateway subscribes to Guilds, GuildMessages, MessageContent, and DirectMessages. DirectMessages is not privileged, so nothing else needs to be switched on.

## 2. Invite the bot

1. **OAuth2** → **URL Generator** → scope **bot** only.
2. Bot permissions: **View Channels**, **Send Messages**, **Read Message History**. Add **Add Reactions** only if your routine uses `discord_react`. Never grant Administrator.
3. Open the generated URL and add the bot to your server.

To DM the bot, open its profile in that server → **Message**. If Discord blocks the DM, enable **Allow direct messages from server members** for that server in your privacy settings.

## 3. Make a private `#inbox` channel (optional if you only use DMs)

The config still needs at least one guild channel or category.

1. Create a text channel, e.g. `#inbox`. In **Permissions**, make it private (deny `@everyone` View Channel).
2. Add **yourself** and the **bot's own role** with View Channel, Send Messages, and Read Message History as channel overrides. Discord returns 50013 Missing Permissions if the bot only gets these through a server-wide role.

Or use a private category holding several intake channels (`#inbox`, `#calendar`, `#research`) and list the category in `DISCORD_CATEGORY_IDS`. Every text channel in it, plus threads in those channels, is in scope. Voice-channel chat and forum posts in the category are ignored.

## 4. Collect IDs (Developer Mode)

Turn on **User Settings → Advanced → Developer Mode**, then:

| Right-click | Copy | Env var |
| --- | --- | --- |
| Server name | Server ID | `DISCORD_GUILD_ID` |
| `#inbox` | Channel ID | `DISCORD_CHANNEL_IDS` (comma-separate if more than one) |
| A category (optional) | Category ID | `DISCORD_CATEGORY_IDS` |
| Your own name/avatar | User ID | `DISCORD_ALLOWED_USER_IDS` (comma-separate to allow more people) |

## 5. Create the webhook routine in Grok Bot

Create a webhook routine in the Grok Bot app, copy its webhook URL and key from the routine panel into `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET`.

The routine needs the `grok-discord` MCP tools (from this plugin) so it can reply, plus your Google Calendar connector and web search for research. Paste the prompt from [Suggested routine prompt](#suggested-routine-prompt) into the routine.

## 6. Environment variables

| Variable | Required | Value |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token (step 1). Secret. |
| `DISCORD_GUILD_ID` | yes | Server ID |
| `DISCORD_CHANNEL_IDS` | one of these two | `#inbox` channel ID(s) |
| `DISCORD_CATEGORY_IDS` | one of these two | Category ID(s). Any text channel in them (and its threads) is in scope. |
| `DISCORD_ALLOWED_USER_IDS` | yes | Your Discord user ID(s). Only these users are handled, in channels and DMs. |
| `GROK_WEBHOOK_URL` | yes | Webhook URL from the routine panel (public HTTPS) |
| `GROK_WEBHOOK_SECRET` | yes | Webhook key from the routine panel. Secret. |
| `DISCORD_INTAKE_MODE` | no | Default `true`: allowed users only, and guild channels need an @mention or a reply to the bot. `false` = legacy chat mode. |
| `DISCORD_DM_INTAKE` | no | Default `true`: every DM from an allowed user is forwarded. `false` = ignore all DMs. |
| `DISCORD_ALLOWED_ROLE_IDS` | no | Extra role check in guild channels, on top of the user allowlist |

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
grok-discord intake mode: 1 allowed user(s); guild channels (1 channel(s), 0 category(ies)) need an @mention or a reply to the bot
grok-discord DM intake on: every DM from an allowed user is forwarded
```

## Payload

Each handled message is POSTed as JSON with `Authorization: Bearer <GROK_WEBHOOK_SECRET>` and `X-Grok-Signature: sha256=<HMAC-SHA256 of the body>`.

A DM with a forwarded message:

```json
{
  "message_id": "1300000000000000001",
  "channel_id": "1400000000000000001",
  "guild_id": null,
  "parent_channel_id": null,
  "is_dm": true,
  "dm_channel_id": "1400000000000000001",
  "author_id": "1000000000000000001",
  "author_username": "you",
  "content": "add to calendar",
  "content_original": "add to calendar",
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

A guild-channel message `@Bot research the new café on 5th`:

```json
{
  "message_id": "1300000000000000002",
  "channel_id": "1200000000000000001",
  "guild_id": "1100000000000000001",
  "parent_channel_id": "1200000000000000001",
  "is_dm": false,
  "dm_channel_id": null,
  "author_id": "1000000000000000001",
  "author_username": "you",
  "content": "research the new café on 5th",
  "content_original": "@Bot research the new café on 5th",
  "content_full": "research the new café on 5th",
  "is_forward": false,
  "forwarded": [],
  "embeds": [],
  "attachments": [],
  "is_reply": false,
  "referenced_message_id": null
}
```

- `channel_id` is what to pass to `discord_reply`: the DM channel for DMs, otherwise the channel or thread the message came from. Replies to thread messages are posted in the parent channel.
- `is_dm` / `dm_channel_id`: for DMs, `dm_channel_id` equals `channel_id` and `guild_id` / `parent_channel_id` are `null`.
- `content` is your own note with the bot's mention removed. `content_original` is the note as typed.
- `content_full` is the note followed by every forwarded message, embed, and attachment URL as plain text. Most routines only need this field.
- `forwarded`, `embeds`, and `attachments` hold the same data in structured form. `embeds` and `attachments` belong to your own message; anything inside a forward is under `forwarded[]`.
- `is_reply` is true only for real replies, not forwards. `referenced_message_id` is the replied-to message.
- Obvious secrets (tokens, keys) are redacted before sending.

`discord_history`, `discord_reply`, `discord_send`, and `discord_react` accept an allowed user's DM channel id as well as allowlisted guild channels. Any other DM is rejected. `discord_history` uses the same extraction, so earlier forwarded items appear with their text, embeds, and attachment URLs.

## Suggested routine prompt

```
You process items the user sends their Discord bot: DMs (is_dm=true)
and @mentions in their private #inbox channel. Reply with the
grok-discord MCP tools. Do not open a Discord Gateway, start threads,
or echo tokens, webhook keys, or env values.

The JSON body has: message_id, channel_id, is_dm, dm_channel_id,
guild_id, parent_channel_id, author_id, content (the user's note,
bot mention removed), content_full (note + forwarded messages +
embeds + attachment URLs), is_forward, forwarded, embeds, attachments.

1. Read content_full. The note (content) says what they want. The
   forwarded text, embeds, and attachments are the material. If the
   note is empty, infer the intent: event-like material (date, time,
   place) -> calendar; otherwise -> research summary.
2. Calendar: extract each event (title, date, start/end time, timezone,
   location, link). Use the user's timezone if none is given. Assume
   1 hour if there is no end time. Add the event(s) to Google Calendar.
   If a key detail like the date is missing or ambiguous, do not guess:
   ask one short question instead.
3. Research: look the topic up, then write a short answer: 3-6 bullets
   with source links.
4. Reply with discord_reply using channel_id, message_id, and author_id
   from the body. For a DM, channel_id is the DM channel
   (= dm_channel_id); otherwise it is the channel or thread the message
   came from (thread messages are answered in the parent channel).
   Use discord_send with channel_id for extra messages.
   Confirm what you did, e.g. "Added: Book club, Thu Nov 6, 6-7pm,
   Library room 2" plus the event link, or the research bullets. Keep
   it under ~1500 characters.
5. If something fails, reply with one plain sentence saying what failed.
   Never post stack traces or secrets.
```
