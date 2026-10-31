---
name: connect-grok-bot
description: Connect Discord to this Grok Bot on the Grok Bot computer. Use when the user says connect Discord, wire Discord, start the Discord worker, or after setup-discord-app keys are ready. Starts the local gateway sidecar and a weekday daily alive-check. Do not use Railway.
---

# Connect Discord on this Grok Bot computer

Native path. The gateway worker runs **on this machine**. Never two Gateways on one `DISCORD_TOKEN`. MCP must never open a Gateway; it only supervises the sidecar over REST.

If Discord keys are missing, run `setup-discord-app` first. If the plugin is not on this computer yet, run `install-discord-plugin` first. Do not ask the user to clone this GitHub repo. Do not ask them to paste the token in chat.

Node **20.19 or newer** is enough. An engines warning on older published floors can still produce `dist/cli.js`. Confirm the build exists, then continue.

## 1. Plugin install and variables

Try **Plugins** → **Discord for Grok Bot** (`grok-discord`). If SearchPlugins for `discord` / `grok-discord` is empty, the marketplace listing is missing. Install from https://github.com/griffinmc22/grokbot-discord-plugin: copy that tree onto this Grok Bot computer.

If the plugin root is not built yet, run `npm install && npm run build` there once. If `package-lock.json` cannot be fetched in one call, regenerate it locally. Register MCP with the launch wrapper, not a raw MCP entry until env is loaded:

```bash
bash ./bin/launch-mcp.sh
```

**Plugins → Configure** may not exist. Persist values this way:

| Value | Where it lives |
| --- | --- |
| `DISCORD_TOKEN` | connector-secrets, via **secret-request**. The launch wrapper reads it at start (`DISCORD_TOKEN` or `DISCORD_TOKEN_FILE`). Never paste it in chat. |
| `DISCORD_GUILD_ID` | launch wrapper / local `.env`. Do not ship one guild’s IDs in the repo. |
| `DISCORD_CHANNEL_IDS` | same. Parent channel snowflakes only. Optional if `DISCORD_CATEGORY_IDS` is set; at least one is required. |
| `DISCORD_CATEGORY_IDS` | same. Optional category snowflakes; every text channel in them (and its threads) is allowed. |
| `DISCORD_ALLOWED_USER_IDS` | same. Comma-separated user snowflakes. Required in intake mode (default); the worker refuses to start without it. |
| `DISCORD_INTAKE_MODE` | optional, default `true`: allowed users only; channels need an @mention or a reply to the bot. `false` = legacy chat mode. |
| `DISCORD_DM_INTAKE` | optional, default `true`: every DM from an allowed user is forwarded. `false` = ignore DMs. |
| `DISCORD_ACK_EMOJI` / `DISCORD_ERROR_EMOJI` | optional, `.env` / gateway env only. Unset = 👀 / ⚠️ reactions; `none`/`off` or an explicitly empty value disables. |
| `BOT_NAME_PREFIX` | optional spoken name (whole-word anywhere, chat mode only). |
| `DISCORD_ALLOWED_ROLE_IDS` | optional extra role check. Empty = no role check. |
| `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET` | runtime env on this computer (gateway process). Copied from the routine panel below. Never commit them. |

Unexpanded `${VAR}` placeholders are ignored. Webhook URLs must pass the plugin SSRF rules (HTTPS, no credentials, no private/metadata hosts, DNS pinned, no redirects). Loopback HTTP is allowed only for local tests.

## 2. Create one inbound webhook routine

Create **one** webhook routine in the Grok Bot app, copy its webhook URL and key from the routine panel into `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET` on the **gateway** env.

In intake mode (the default) use the routine prompt in `docs/INTAKE-BRIDGE.md` instead of the chat prompt below.

In chat mode (`DISCORD_INTAKE_MODE=false`), put this prompt on the inbound routine:

```
You are answering Discord through the grok-discord MCP tools only.
Do not open a Discord Gateway. Do not start a thread. Do not echo
tokens, webhook keys, PEMs, JWTs, API keys, or env files.

The gateway already decided this line looked directed at the bot.
That decision is not always right. You must still choose SILENCE.

Parse the JSON body:
  message_id, channel_id, guild_id, parent_channel_id,
  author_id, author_username, content, content_full, is_forward,
  forwarded, embeds, attachments, is_reply, referenced_message_id
  (content_full has the note plus any forwarded text, embeds, and
  attachment URLs in one block)

1. Call discord_history on parent_channel_id for recent context.
   Reply in the parent channel even if the event came from a thread.
2. Decide whether the author is talking TO the bot, or only
   ABOUT the bot / someone else.
3. If you should answer, call discord_reply with that message_id,
   the inbound channel_id, the inbound author_id, and the answer.
4. If you should not answer, reply with exactly SILENCE
   (or skip the tool). Empty text also posts nothing.

SILENCE in these cases:
- Third-person talk that only mentions the bot's name
  (example shape: "ghost say hello to chief").
- Follow-up noise that is not for the bot
  (example shape: "ghost health check").
- Ambient chat that happened to contain the bot name as a word.
- Anything that is not a real request to this bot.
- You have nothing useful to say.

Answer when:
- The author @mentions the bot and is asking it to do something.
- The author addresses the bot by name as the intended recipient
  (example shape: "chief say hello to ghost").
- This is a real continuation of a conversation you already joined.

Never start a thread.
Never post stack traces. The public error line is already:
  Something broke on my side. Not saying more here.
```

The gateway POSTs that JSON with `X-Grok-Signature: sha256=<hmac>` and `Authorization: Bearer <secret>`.

`discord_status.webhookConfigured` can stay false even when the gateway has the URL. Trust the gateway env and `~/.grok-discord/worker-*.log`.

## 3. Start exactly one worker

Call **`discord_ensure_worker`**. That starts the gateway sidecar if it is down and **no-ops if the supervisor is already alive**. It does not open a Gateway inside MCP.

CLI from the plugin root (after build), through the same env wrapper:

```bash
bash ./bin/with-env.sh node dist/cli.js ensure
bash ./bin/with-env.sh node dist/cli.js status
```

`discord_worker_status` reports `{ "running": true|false }` without secrets.

Logs should show `grok-discord ready as YourBot#1234; one replica per bot token` in `~/.grok-discord/worker-*.log`. If `GROK_WEBHOOK_URL` is missing at boot, the worker also prints that inbound will not wake a Grok Bot. `/status` and `/new` do not need the webhook.

After you change env (webhook URL, channel list, name prefix):

1. Reload MCP if those values live in the launch wrapper.
2. Call **`discord_restart_worker`** (or `bash ./bin/with-env.sh node dist/cli.js restart`).

`ensure` will not pick up env changes while the supervisor is alive. The pidfile `~/.grok-discord/worker-<fingerprint>.pid` is JSON `{ "supervisorPid", "startedAt" }`, not a raw pid. Never start a second gateway on the same token.

## 4. Weekday daily alive-check

Do **not** save a 5-minute `discord_ensure_worker` loop. Save one **weekday daily** scheduled routine. Example cron: `27 8 * * 1-5` (08:27 UTC, Monday–Friday). Intent:

```
Once each weekday, keep the Discord gateway worker alive on this Grok Bot computer.

1. Call discord_ensure_worker (same as `node dist/cli.js ensure` from the plugin root).
2. If action is already-running, do nothing else. Stay silent. Do not message Discord.
3. If action is started, the worker was dead and is now up. Stay silent unless it failed.
4. If it failed, report the error in this conversation only. Never post DISCORD_TOKEN, GROK_WEBHOOK_SECRET, or GROK_WEBHOOK_URL.

Do not start a second Gateway. Do not open a discord.js Client from MCP. Do not use Railway.
```

## 5. Test

Use the verification order in `docs/GROK-BOT-INSTALL.md`: REST status, send, worker ready without a missing-URL warning, one replica, `@Bot /status`, gateway env has the webhook URL, inbound `lastRunAt` after `@Bot hello`, name vs third-person SILENCE, other channels silent.

`@Bot /status` and `@Bot /new` are local and do not wake inference. A silent `/status` is a 50013 / channel-overwrite problem, not a webhook problem.

Do not use Railway. Do not open a Gateway inside MCP.
