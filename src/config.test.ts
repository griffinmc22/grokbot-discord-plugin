import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, usableEnvValue } from "./config.ts";

const snowflakeGuild = "111111111111111111";
const snowflakeChannel = "222222222222222222";
const snowflakeUser = "333333333333333333";
const snowflakeUser2 = "444444444444444444";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DISCORD_TOKEN: "test-token",
    DISCORD_GUILD_ID: snowflakeGuild,
    DISCORD_CHANNEL_IDS: snowflakeChannel,
    DISCORD_ALLOWED_USER_IDS: snowflakeUser,
    ...overrides,
  };
}

describe("intake mode and user allowlist", () => {
  it("defaults to intake mode and parses a comma-separated user allowlist", () => {
    const config = loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: ` ${snowflakeUser}, ${snowflakeUser2},${snowflakeUser} ` }));

    assert.equal(config.intakeMode, true);
    assert.deepEqual(config.discordAllowedUserIds, [snowflakeUser, snowflakeUser2]);
  });

  it("fails closed in intake mode when no user IDs are set", () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: undefined })), /DISCORD_ALLOWED_USER_IDS is required/);
    assert.throws(() => loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: " , " })), /DISCORD_ALLOWED_USER_IDS is required/);
    assert.throws(
      () => loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: "${DISCORD_ALLOWED_USER_IDS}" })),
      /DISCORD_ALLOWED_USER_IDS is required/,
    );
  });

  it("rejects non-snowflake user IDs", () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: "griffin" })), /snowflake/);
  });

  it("allows an empty user list only when intake mode is explicitly off", () => {
    const config = loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: "", DISCORD_INTAKE_MODE: "false" }));

    assert.equal(config.intakeMode, false);
    assert.deepEqual(config.discordAllowedUserIds, []);
  });

  it("rejects an unparseable DISCORD_INTAKE_MODE", () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_INTAKE_MODE: "maybe" })), /DISCORD_INTAKE_MODE/);
    assert.equal(loadConfig(baseEnv({ DISCORD_INTAKE_MODE: "ON" })).intakeMode, true);
  });
});

describe("usableEnvValue", () => {
  it("treats Cursor and empty placeholders as unset", () => {
    assert.equal(usableEnvValue("${DISCORD_TOKEN}"), undefined);
    assert.equal(usableEnvValue("${{secrets.DISCORD_TOKEN}}"), undefined);
    assert.equal(usableEnvValue("{{DISCORD_TOKEN}}"), undefined);
    assert.equal(usableEnvValue(""), undefined);
    assert.equal(usableEnvValue(" real "), "real");
  });
});

describe("loadConfig", () => {
  it("loads snowflake allowlists and ignores placeholder optional vars", () => {
    const config = loadConfig(
      baseEnv({
        DISCORD_ALLOWED_ROLE_IDS: "${DISCORD_ALLOWED_ROLE_IDS}",
        BOT_NAME_PREFIX: "${BOT_NAME_PREFIX}",
        GROK_WEBHOOK_URL: "${GROK_WEBHOOK_URL}",
      }),
    );

    assert.equal(config.discordGuildId, snowflakeGuild);
    assert.deepEqual(config.discordChannelIds, [snowflakeChannel]);
    assert.deepEqual(config.discordAllowedRoleIds, []);
    assert.equal(config.botNamePrefix, undefined);
    assert.equal(config.grokWebhookUrl, undefined);
  });

  it("requires a webhook secret when a webhook URL is set", () => {
    assert.throws(
      () => loadConfig(baseEnv({ GROK_WEBHOOK_URL: "https://hooks.example.com/grok" })),
      /GROK_WEBHOOK_SECRET/,
    );

    const config = loadConfig(
      baseEnv({
        GROK_WEBHOOK_URL: "https://hooks.example.com/grok",
        GROK_WEBHOOK_SECRET: "sender-key",
      }),
    );
    assert.equal(config.grokWebhookUrl, "https://hooks.example.com/grok");
  });

  it("rejects non-snowflake channel ids", () => {
    assert.throws(
      () => loadConfig(baseEnv({ DISCORD_CHANNEL_IDS: "../../users/@me" })),
      /snowflake/,
    );
  });
});

describe("channel and category scope", () => {
  const snowflakeCategory = "666666666666666666";

  it("accepts categories alone, with no channel list", () => {
    const config = loadConfig(baseEnv({ DISCORD_CHANNEL_IDS: undefined, DISCORD_CATEGORY_IDS: snowflakeCategory }));

    assert.deepEqual(config.discordChannelIds, []);
    assert.deepEqual(config.discordCategoryIds, [snowflakeCategory]);
  });

  it("accepts channels and categories together and defaults categories to empty", () => {
    const both = loadConfig(baseEnv({ DISCORD_CATEGORY_IDS: `${snowflakeCategory}, ${snowflakeCategory}` }));
    assert.deepEqual(both.discordChannelIds, [snowflakeChannel]);
    assert.deepEqual(both.discordCategoryIds, [snowflakeCategory]);

    assert.deepEqual(loadConfig(baseEnv()).discordCategoryIds, []);
  });

  it("requires at least one of DISCORD_CHANNEL_IDS or DISCORD_CATEGORY_IDS", () => {
    assert.throws(
      () => loadConfig(baseEnv({ DISCORD_CHANNEL_IDS: undefined, DISCORD_CATEGORY_IDS: undefined })),
      /DISCORD_CHANNEL_IDS or DISCORD_CATEGORY_IDS/,
    );
    assert.throws(
      () => loadConfig(baseEnv({ DISCORD_CHANNEL_IDS: " , ", DISCORD_CATEGORY_IDS: "${DISCORD_CATEGORY_IDS}" })),
      /DISCORD_CHANNEL_IDS or DISCORD_CATEGORY_IDS/,
    );
  });

  it("rejects non-snowflake category ids", () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_CATEGORY_IDS: "inbox" })), /DISCORD_CATEGORY_IDS must be a Discord snowflake/);
  });

  it("still fails closed on the user allowlist when only categories are set", () => {
    assert.throws(
      () =>
        loadConfig(
          baseEnv({ DISCORD_CHANNEL_IDS: undefined, DISCORD_CATEGORY_IDS: snowflakeCategory, DISCORD_ALLOWED_USER_IDS: undefined }),
        ),
      /DISCORD_ALLOWED_USER_IDS is required/,
    );
  });
});

describe("DM intake", () => {
  it("defaults DISCORD_DM_INTAKE to on and parses false", () => {
    assert.equal(loadConfig(baseEnv()).dmIntake, true);
    assert.equal(loadConfig(baseEnv({ DISCORD_DM_INTAKE: "false" })).dmIntake, false);
    assert.equal(loadConfig(baseEnv({ DISCORD_DM_INTAKE: "1" })).dmIntake, true);
  });

  it("rejects an unparseable DISCORD_DM_INTAKE", () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_DM_INTAKE: "sometimes" })), /DISCORD_DM_INTAKE must be true or false/);
  });

  it("defaults to intake mode (mention-required guild + DM auto) with the fail-closed user allowlist", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.intakeMode, true);
    assert.equal(config.dmIntake, true);
    assert.deepEqual(config.discordAllowedUserIds, [snowflakeUser]);
    assert.throws(() => loadConfig(baseEnv({ DISCORD_ALLOWED_USER_IDS: undefined })), /DISCORD_ALLOWED_USER_IDS is required/);
  });
});
