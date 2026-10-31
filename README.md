# Discord for Grok Bot

Talk to your Grok Bot from Discord. It only replies in the server channels you choose, and in DMs from users you allow. Other channels and other people's DMs stay quiet.

**This fork is an intake bridge by default.** DM the bot, or forward any Discord message to it, and every message from your allowlisted user ID goes to a Grok Bot webhook routine with no mention needed. In allowlisted server channels, @mention the bot or reply to it. The routine adds Google Calendar events or does research, then confirms with a reply. Setup, env vars, payload shape, and a routine prompt are in [docs/INTAKE-BRIDGE.md](docs/INTAKE-BRIDGE.md). The steps below describe the original chat setup. Intake mode requires `DISCORD_ALLOWED_USER_IDS`. `DISCORD_INTAKE_MODE=false` restores the legacy name and follow-up matching in channels.

## 1. Install the plugin

Paste this into a chat with your Grok Bot:

```
Install Discord for Grok Bot from https://github.com/griffinmc22/grokbot-discord-plugin and connect it. Follow docs/GROK-BOT-INSTALL.md in that repo exactly.
```

Or: **Plugins** → **Discord for Grok Bot** → **Install**, then type **connect Discord**.

## 2. Create a Discord bot

This is a one-time setup on Discord’s website. Keep a notes app open to paste four values.

### Make the app

1. Open [discord.com/developers/applications](https://discord.com/developers/applications) and sign in.
2. Click **New Application**. Name it what people will type when they @mention it.
3. Open **Bot**.
4. Click **Reset Token** and copy the token. That is `DISCORD_TOKEN`. Treat it like a password. Never post it in Discord.
5. Turn **Message Content Intent** **on**. Leave Presence and Server Members **off**.
6. Click **Save Changes**.

### Invite it to your server

1. Open **OAuth2** → **URL Generator**.
2. Under Scopes, check **bot** only.
3. Under Bot Permissions, check only:
  - View Channels
  - Send Messages
  - Read Message History
  - Embed Links
  - Add Reactions
4. Do **not** check Administrator.
5. Copy the URL at the bottom, open it, pick your server, and authorize.

In each Discord channel the bot should use, give it those same channel permissions. Do not give it access to channels you want to keep private.

### Copy your server and channel IDs

1. In Discord: **User Settings** → **Advanced** → turn **Developer Mode** on.
2. Right-click the **server name** → **Copy Server ID**. That is `DISCORD_GUILD_ID`.
3. Right-click each text channel the bot may use → **Copy Channel ID**. If there is more than one, put them in a list separated by commas. That is `DISCORD_CHANNEL_IDS`.
4. Optional: to allow every text channel in a category (and threads in those channels), right-click the **category** → **Copy Category ID** and list them, comma-separated, as `DISCORD_CATEGORY_IDS`. Set at least one of `DISCORD_CHANNEL_IDS` or `DISCORD_CATEGORY_IDS`.

| Env var | Required | What |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_GUILD_ID` | yes | Server ID |
| `DISCORD_CHANNEL_IDS` | one of these two | Comma-separated text channel IDs |
| `DISCORD_CATEGORY_IDS` | one of these two | Comma-separated category IDs; every text channel under them is allowed |
| `DISCORD_ALLOWED_USER_IDS` | yes in intake mode | Comma-separated user IDs that may use the bot (channels and DMs) |
| `DISCORD_INTAKE_MODE` | no | Default `true`: allowed users only, and channels need an @mention or a reply to the bot. `false` = legacy chat mode |
| `DISCORD_DM_INTAKE` | no | Default `true`: every DM from an allowed user is forwarded, no mention. `false` = ignore DMs |
| `DISCORD_ALLOWED_ROLE_IDS` | no | Extra role check (guild channels only) |
| `DISCORD_ACK_EMOJI` | no | Reaction added the moment a message is accepted. Unset = 👀; `none`/`off` (or set to empty) = no reaction |
| `DISCORD_ERROR_EMOJI` | no | Reaction added if forwarding fails. Unset = ⚠️; `none`/`off` (or set to empty) = no reaction |
| `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_SECRET` | for inbound | Webhook URL and key from the Grok Bot routine panel |
| `HEALTH_INTERVAL_MS` | no | Default `30000`. How often the gateway checks its connection and writes the health file |
| `HEALTH_MAX_UNHEALTHY_MS` | no | Default `120000`. Disconnected this long → the gateway exits 1 so its supervisor restarts it |
| `HEALTH_REST_INTERVAL_MS` | no | Default `300000`. REST liveness check; 3 failures in a row → exit 1 |
| `DISCORD_HEALTH_FILE` | no | Default `<repo>/.health`. Gets `<epoch-ms> <ISO time>` while healthy |
| `DISCORD_DEBUG` | no | Default `false`. `true` also logs heartbeat debug lines |
| `HEALTH_STALE_SECONDS` / `HEALTH_STARTUP_GRACE_SECONDS` | no | `bin/run-forever.sh` only. Defaults `180` / `120`: kill the gateway if the health file is older than this, after the grace |

## 3. Save those values in Grok Bot

When Grok Bot asks, give it the token, server ID, and channel IDs. Never paste the token in Discord or in a public chat.

## 4. Connect Discord

If you used the paste in step 1, Grok Bot is already doing this. Otherwise type:

**connect Discord**

Follow what it asks. It will finish the connection and start listening on this Grok Bot computer.

## 5. Try it

In one of the Discord channels you listed, type:

**@YourBot hello**

You should get a reply in that same channel.

- Other channels: no reply
- Direct messages: forwarded only from users in `DISCORD_ALLOWED_USER_IDS` (DM intake). Everyone else gets no reply.
- **@YourBot /status** — checks that it is online
- **@YourBot /new** — starts a fresh conversation

If something is missing, tell your Grok Bot **help me set up Discord**.

## Keep it running

If the gateway loses its Discord connection, it exits on its own (code 1) so it can be restarted. The MCP worker (`connect Discord`) restarts it automatically. To run it yourself, use the included supervisor:

```bash
npm run build
bin/run-forever.sh .env
```

Details are under **Reliability** in [docs/INTAKE-BRIDGE.md](docs/INTAKE-BRIDGE.md).

## Tips

- Use one Discord server.
- Only list channels you are happy for the bot to read and write in.
- If the token ever leaks, reset it in the Discord Developer Portal and tell your Grok Bot.
- After you change settings, say **connect Discord** again.

MIT licensed. Originally made by NinjaProtocol; this fork (https://github.com/griffinmc22/grokbot-discord-plugin) adapts it into a Discord intake bridge.
