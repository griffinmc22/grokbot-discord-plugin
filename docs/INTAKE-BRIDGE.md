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
2. Bot permissions: **View Channels**, **Send Messages**, **Read Message History**, **Add Reactions**. Add Reactions and Read Message History are needed for the instant 👀 acknowledgement (see [Reactions](#reactions)). Never grant Administrator.
3. Open the generated URL and add the bot to your server.

To DM the bot, open its profile in that server → **Message**. If Discord blocks the DM, enable **Allow direct messages from server members** for that server in your privacy settings.

## 3. Make a private `#inbox` channel (optional if you only use DMs)

The config still needs at least one guild channel or category.

1. Create a text channel, e.g. `#inbox`. In **Permissions**, make it private (deny `@everyone` View Channel).
2. Add **yourself** and the **bot's own role** with View Channel, Send Messages, Read Message History, and Add Reactions as channel overrides. Discord returns 50013 Missing Permissions if the bot only gets these through a server-wide role.

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
| `DISCORD_ACK_EMOJI` | no | Unset = 👀. Reaction added the moment a message is accepted. `none`/`off`, or an explicitly empty value, disables it. |
| `DISCORD_ERROR_EMOJI` | no | Unset = ⚠️. Reaction added if forwarding fails. Same disable rules. |
| `HEALTH_INTERVAL_MS` | no | Default `30000`. Health check and health-file write interval |
| `HEALTH_MAX_UNHEALTHY_MS` | no | Default `120000`. Unhealthy this long → exit 1 |
| `HEALTH_REST_INTERVAL_MS` | no | Default `300000`. REST liveness check interval; 3 failures in a row → exit 1 |
| `DISCORD_HEALTH_FILE` | no | Default `<repo>/.health` |
| `DISCORD_DEBUG` | no | Default `false`. `true` logs heartbeat debug lines |
| `HEALTH_STALE_SECONDS` / `HEALTH_STARTUP_GRACE_SECONDS` | no | `bin/run-forever.sh` only. Defaults `180` / `120` |
| `SUPERVISOR_PIDFILE` | no | `bin/run-forever.sh` only. Default `<repo>/.supervisor.pid` |
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

To run it without the MCP host, use `bin/run-forever.sh .env` (see [Reliability](#reliability)). For a foreground run while debugging, use `bash ./bin/with-env.sh node dist/cli.js gateway`. From Grok Bot itself you can use the MCP tools `discord_ensure_worker` and `discord_restart_worker` instead. Run one gateway per bot token.

Expected log lines (`~/.grok-discord/worker-*.log`):

```
grok-discord ready as YourBot#1234; one replica per bot token
grok-discord intake mode: 1 allowed user(s); guild channels (1 channel(s), 0 category(ies)) need an @mention or a reply to the bot
grok-discord DM intake on: every DM from an allowed user is forwarded
```

Each line is prefixed with an ISO timestamp.

## Reliability

A gateway that stays alive but silently loses its Discord connection is caught and restarted. The gateway notices on its own, exits, and whatever supervises it starts a fresh one.

**Connection events.** Each one is logged as a single timestamped line, with no secrets: `shardDisconnect` (with the close code), `shardReconnecting`, `shardResume` (with the number of replayed events), `shardReady`, `shardError`, `invalidated`, `error`, and `warn`. With `DISCORD_DEBUG=true`, heartbeat debug lines are logged too.

**Health watchdog.** Every `HEALTH_INTERVAL_MS` (30 s) the gateway checks that its connection is Ready and its heartbeat latency is finite and under 10 s. A latency of `-1` (no heartbeat yet) is accepted only for the first 60 s after connecting. While healthy, it writes `<epoch-ms> <ISO time>` to `DISCORD_HEALTH_FILE` (default `<repo>/.health`, git-ignored), replacing the file in one step so readers never see half a write. If it's unhealthy for longer than `HEALTH_MAX_UNHEALTHY_MS` (120 s, counted from startup, so a gateway that never connects is caught too), it logs why and exits 1. Every `HEALTH_REST_INTERVAL_MS` (5 min) it also makes an authenticated REST call (`GET /users/@me`). Three failures in a row exit 1.

**Fatal errors and signals.** An unhandled promise rejection or uncaught exception is logged as one line and exits 1. `SIGTERM`/`SIGINT` stop the timers, close the Discord connection, and exit 0 within about 3 s.

**One gateway per bot token.** The gateway takes a lock in `~/.grok-discord/gateway-<token-fingerprint>.lock` and refreshes it every time it writes the health file. It's released on every exit, including the watchdog and fatal-error exits, so a restart is never blocked. A lock left by a killed gateway is taken over once its process is gone or it hasn't been refreshed for `HEALTH_MAX_UNHEALTHY_MS + 2 × HEALTH_INTERVAL_MS` (3 min). A second gateway started while a healthy one holds the lock exits with code 3.

| Exit code | Meaning | Supervisor should |
| --- | --- | --- |
| 0 | Stopped by `SIGTERM`/`SIGINT` | Restart unless you are stopping it |
| 1 | Unhealthy, invalidated session, failed REST checks, fatal error, or bad config | Restart (with backoff) |
| 3 | Another gateway for this bot token is already running | Back off; the other one is serving |

**Run it under a supervisor.** Use one of these, never both for the same bot token (the lock enforces this):

- **MCP worker** (`discord_ensure_worker` / `node dist/cli.js ensure`): the `supervise` process restarts the gateway after any exit. Its backoff doubles to 30 s and resets after the gateway has run for at least 5 minutes.
- **`bin/run-forever.sh <env-file>`** (POSIX `sh`): sources the env file and runs `node dist/cli.js gateway` in a loop. It restarts on any exit, with backoff from 2 s doubling to 60 s and back to 2 s after a 5-minute run. A background check kills the gateway if the health file is older than `HEALTH_STALE_SECONDS` (180) after a `HEALTH_STARTUP_GRACE_SECONDS` (120) startup grace, which also catches a gateway too wedged to run its own watchdog. `SIGTERM`/`SIGINT` stop the gateway and exit. It writes its pid to `.supervisor.pid` (`SUPERVISOR_PIDFILE`) and refuses to start while another live supervisor holds it. It logs timestamped lines to stdout and never prints env values.

```bash
npm ci && npm run build
bin/run-forever.sh .env                  # foreground
nohup bin/run-forever.sh .env >> gateway.log 2>&1 &   # background
```

Under systemd, launchd, or Docker you can use their restart policy (`Restart=always`, `--restart unless-stopped`) on `node dist/cli.js gateway` directly. Add a health check that fails when the health file is older than about 3 minutes.


## Reactions

As soon as a message passes every check (allowed user, channel/category or DM, mention or reply, role, rate limit), the gateway reacts with `DISCORD_ACK_EMOJI` (default 👀). That way you know it was picked up before the routine replies. The reaction runs alongside the webhook POST and never delays or blocks it. Messages the gateway ignores, or drops for rate limiting, get no reaction.

If forwarding fails, the gateway removes the 👀 when it can and adds `DISCORD_ERROR_EMOJI` (default ⚠️), on top of the usual public error reply.

- Values: a unicode emoji, a custom emoji as `name:id` or `<:name:id>` (the bot must be in that emoji's server), or `none` / `off` (also `false`, `no`, `0`, `disabled`) to turn it off. An explicitly empty value (`DISCORD_ACK_EMOJI=`) also turns it off. Leaving the variable unset keeps the default, which is why `.env.example` has these lines commented out.
- Permissions: in guild channels the bot needs **Add Reactions** and **Read Message History** in that channel. DMs need nothing extra.
- Failures are best-effort and logged as one line, e.g. `grok-discord ack reaction failed: 50013 Missing Permissions` (missing Add Reactions) or `grok-discord ack reaction failed: timed out after 3000ms`. Forwarding still happens.
- Set these in `.env` or the gateway/launch-wrapper env. They are deliberately not mapped in `mcp.json`: a host that expands an unset `${DISCORD_ACK_EMOJI}` to an empty string would silently turn reactions off.

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
