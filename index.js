const {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

const TOKEN = process.env.TOKEN;
const db = new sqlite3.Database("./settings.db");

const CHECK_INTERVAL_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;
const FAILURE_THRESHOLD = 2;
const SUCCESS_THRESHOLD = 2;
const MAX_BODY_CHARS = 4000;

const UPDATE_ERROR_MESSAGE =
  "This service is temperarely unavailable due to updates. The estmated waiting time will be 7 minutes. Thnak yoiu for your time: Error Code: X0UP";

const MAINTENANCE_KEYWORDS = [
  "maintenance",
  "temporarily unavailable",
  "update in progress",
  "updating",
  "service unavailable",
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// guildId -> { health, consecutiveFailures, consecutiveSuccesses, lastResult }
const monitorStateByGuild = new Map();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      website TEXT NOT NULL,
      channel_id TEXT NOT NULL
    )
  `);
});

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function normalizeWebsite(input) {
  const trimmed = input.trim();
  const prefixed = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(prefixed);
  return url.toString();
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function detectMaintenance(text) {
  const lower = (text || "").toLowerCase();
  return MAINTENANCE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function formatHealth(health) {
  if (health === "up") return "Online";
  if (health === "maintenance") return "Maintenance";
  if (health === "down") return "Offline";
  return "Unknown";
}

function healthColor(health) {
  if (health === "up") return 0x2ecc71;
  if (health === "maintenance") return 0xf39c12;
  return 0xe74c3c;
}

function healthIcon(health) {
  if (health === "up") return "✅";
  if (health === "maintenance") return "🛠️";
  return "🚨";
}

async function readBodySnippet(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isTextual =
    contentType.includes("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml");

  if (!isTextual) return "";

  const text = await response.text();
  return shorten(text, MAX_BODY_CHARS);
}

function classifyResult(statusCode, bodySnippet) {
  if (detectMaintenance(bodySnippet)) {
    return {
      health: "maintenance",
      reason: "Maintenance text detected in website response",
    };
  }

  if (statusCode >= 200 && statusCode < 400) {
    return { health: "up", reason: "Healthy HTTP response" };
  }

  if (statusCode === 429) {
    return { health: "down", reason: "Rate limited (HTTP 429)" };
  }

  if (statusCode >= 500) {
    return { health: "down", reason: `Server error (HTTP ${statusCode})` };
  }

  // 4xx means the server is reachable, so keep it as online to reduce false outages.
  return {
    health: "up",
    reason: `Reachable but returned HTTP ${statusCode}`,
  };
}

async function probeWebsite(website) {
  let lastResult = {
    health: "down",
    statusCode: null,
    latencyMs: null,
    attempts: MAX_RETRIES,
    reason: "Unknown error",
    errorType: "unknown",
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(website, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const bodySnippet = await readBodySnippet(response);
      const classification = classifyResult(response.status, bodySnippet);
      const latencyMs = Date.now() - startedAt;

      lastResult = {
        health: classification.health,
        statusCode: response.status,
        latencyMs,
        attempts: attempt,
        reason: classification.reason,
        errorType: null,
      };

      if (classification.health === "up" || classification.health === "maintenance") {
        return lastResult;
      }
    } catch (error) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startedAt;
      const isTimeout = error?.name === "AbortError";
      const reason = isTimeout
        ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : error?.message || "Network error";

      lastResult = {
        health: "down",
        statusCode: null,
        latencyMs,
        attempts: attempt,
        reason,
        errorType: isTimeout ? "timeout" : "network",
      };
    }

    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAY_MS);
    }
  }

  return lastResult;
}

function buildStatusEmbed({ website, result, mode, previousHealth, failureCount, successCount }) {
  const site = new URL(website);
  const currentHealth = result.health;

  let title;
  let description;

  if (mode === "setup") {
    title = `${healthIcon(currentHealth)} Monitor Initialized`;
    description =
      currentHealth === "maintenance"
        ? UPDATE_ERROR_MESSAGE
        : "Monitoring is active. Initial health check completed.";
  } else if (mode === "recovered") {
    title = "✅ Service Recovered";
    description =
      previousHealth === "maintenance"
        ? "Maintenance appears to be completed and the site is responding normally."
        : "The monitored website is responding again.";
  } else {
    title =
      currentHealth === "maintenance"
        ? "🛠️ Maintenance Detected"
        : "🚨 Service Outage Detected";
    description =
      currentHealth === "maintenance"
        ? UPDATE_ERROR_MESSAGE
        : "The monitored website is currently unavailable.";
  }

  return new EmbedBuilder()
    .setAuthor({ name: "DownDetector Smart Monitor" })
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: "Website", value: website },
      { name: "Host", value: site.host, inline: true },
      { name: "Status", value: formatHealth(currentHealth), inline: true },
      {
        name: "HTTP",
        value: result.statusCode ? String(result.statusCode) : "No response",
        inline: true,
      },
      {
        name: "Latency",
        value: result.latencyMs ? `${result.latencyMs}ms` : "n/a",
        inline: true,
      },
      {
        name: "Attempts",
        value: `${result.attempts}/${MAX_RETRIES}`,
        inline: true,
      },
      {
        name: "Reason",
        value: shorten(result.reason || "No details", 1024),
      },
      {
        name: "Monitor Rules",
        value: `Checks every ${CHECK_INTERVAL_MS / 1000}s | Down threshold ${FAILURE_THRESHOLD} | Recovery threshold ${SUCCESS_THRESHOLD}`,
      },
      {
        name: "Consecutive Counts",
        value: `Failures: ${failureCount} | Successes: ${successCount}`,
      }
    )
    .setColor(healthColor(currentHealth))
    .setFooter({ text: "Automatic monitoring event" })
    .setTimestamp();
}

async function sendMonitorMessage(channelId, payload) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const embed = buildStatusEmbed(payload);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Failed to send monitor message:", error);
  }
}

function initialState() {
  return {
    health: "unknown",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastResult: null,
  };
}

async function processGuildCheck({ guildId, website, channelId }) {
  const result = await probeWebsite(website);
  const state = monitorStateByGuild.get(guildId) || initialState();

  state.lastResult = result;

  if (result.health === "up") {
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses += 1;

    if (state.health === "unknown") {
      state.health = "up";
    } else if (state.health !== "up" && state.consecutiveSuccesses >= SUCCESS_THRESHOLD) {
      const previousHealth = state.health;
      state.health = "up";
      await sendMonitorMessage(channelId, {
        website,
        result,
        mode: "recovered",
        previousHealth,
        failureCount: state.consecutiveFailures,
        successCount: state.consecutiveSuccesses,
      });
    }
  } else {
    state.consecutiveSuccesses = 0;
    state.consecutiveFailures += 1;

    if (state.health === "unknown") {
      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.health = result.health;
        await sendMonitorMessage(channelId, {
          website,
          result,
          mode: "outage",
          previousHealth: "unknown",
          failureCount: state.consecutiveFailures,
          successCount: state.consecutiveSuccesses,
        });
      }
    } else if (state.health === "up") {
      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.health = result.health;
        await sendMonitorMessage(channelId, {
          website,
          result,
          mode: "outage",
          previousHealth: "up",
          failureCount: state.consecutiveFailures,
          successCount: state.consecutiveSuccesses,
        });
      }
    } else if (state.health !== result.health && state.consecutiveFailures >= FAILURE_THRESHOLD) {
      // Non-up state changed (e.g., down -> maintenance); post an updated outage message.
      state.health = result.health;
      await sendMonitorMessage(channelId, {
        website,
        result,
        mode: "outage",
        previousHealth: "down",
        failureCount: state.consecutiveFailures,
        successCount: state.consecutiveSuccesses,
      });
    }
  }

  monitorStateByGuild.set(guildId, state);
}

async function checkSites() {
  const settings = await all("SELECT guild_id, website, channel_id FROM guild_settings");

  for (const { guild_id: guildId, website, channel_id: channelId } of settings) {
    await processGuildCheck({ guildId, website, channelId });
  }
}

async function registerGuildCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Configure website monitoring for this server")
      .addStringOption((option) =>
        option
          .setName("website")
          .setDescription("Website URL to monitor")
          .setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel for status alerts")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("change-site")
      .setDescription("Change the monitored website")
      .addStringOption((option) =>
        option
          .setName("website")
          .setDescription("New website URL to monitor")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("change-channel")
      .setDescription("Change the alert channel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("New channel for status alerts")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      ),
  ].map((cmd) => cmd.toJSON());

  await guild.commands.set(commands);
}

async function registerCommandsForAllGuilds() {
  const guilds = await client.guilds.fetch();
  await Promise.all(
    guilds.map(async (oauthGuild) => {
      const guild = await oauthGuild.fetch();
      await registerGuildCommands(guild);
    })
  );
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommandsForAllGuilds();
  setInterval(checkSites, CHECK_INTERVAL_MS);
  await checkSites();
});

client.on("guildCreate", async (guild) => {
  await registerGuildCommands(guild);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return;

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: "You must be an Administrator to use this command.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "setup") {
    const channel = interaction.options.getChannel("channel", true);
    const websiteInput = interaction.options.getString("website", true);

    let website;
    try {
      website = normalizeWebsite(websiteInput);
    } catch {
      await interaction.reply({
        content: "That website URL is invalid.",
        ephemeral: true,
      });
      return;
    }

    await run(
      `
      INSERT INTO guild_settings (guild_id, website, channel_id)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        website = excluded.website,
        channel_id = excluded.channel_id
    `,
      [interaction.guildId, website, channel.id]
    );

    const result = await probeWebsite(website);
    monitorStateByGuild.set(interaction.guildId, {
      health: result.health,
      consecutiveFailures: result.health === "up" ? 0 : FAILURE_THRESHOLD,
      consecutiveSuccesses: result.health === "up" ? 1 : 0,
      lastResult: result,
    });

    await sendMonitorMessage(channel.id, {
      website,
      result,
      mode: "setup",
      previousHealth: "unknown",
      failureCount: result.health === "up" ? 0 : FAILURE_THRESHOLD,
      successCount: result.health === "up" ? 1 : 0,
    });

    await interaction.reply({
      content: `Setup complete. Monitoring ${website} in <#${channel.id}> with smart detection and improved alerts.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "change-site") {
    const existing = await get("SELECT guild_id FROM guild_settings WHERE guild_id = ?", [
      interaction.guildId,
    ]);

    if (!existing) {
      await interaction.reply({
        content: "Run /setup first.",
        ephemeral: true,
      });
      return;
    }

    const websiteInput = interaction.options.getString("website", true);
    let website;
    try {
      website = normalizeWebsite(websiteInput);
    } catch {
      await interaction.reply({
        content: "That website URL is invalid.",
        ephemeral: true,
      });
      return;
    }

    await run("UPDATE guild_settings SET website = ? WHERE guild_id = ?", [
      website,
      interaction.guildId,
    ]);

    const result = await probeWebsite(website);
    monitorStateByGuild.set(interaction.guildId, {
      health: result.health,
      consecutiveFailures: result.health === "up" ? 0 : FAILURE_THRESHOLD,
      consecutiveSuccesses: result.health === "up" ? 1 : 0,
      lastResult: result,
    });

    const channelRow = await get(
      "SELECT channel_id FROM guild_settings WHERE guild_id = ?",
      [interaction.guildId]
    );

    if (channelRow?.channel_id) {
      await sendMonitorMessage(channelRow.channel_id, {
        website,
        result,
        mode: "setup",
        previousHealth: "unknown",
        failureCount: result.health === "up" ? 0 : FAILURE_THRESHOLD,
        successCount: result.health === "up" ? 1 : 0,
      });
    }

    await interaction.reply({
      content: `Updated website to ${website} and posted a fresh status check.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "change-channel") {
    const existing = await get("SELECT guild_id, website FROM guild_settings WHERE guild_id = ?", [
      interaction.guildId,
    ]);

    if (!existing) {
      await interaction.reply({
        content: "Run /setup first.",
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    await run("UPDATE guild_settings SET channel_id = ? WHERE guild_id = ?", [
      channel.id,
      interaction.guildId,
    ]);

    const result =
      (monitorStateByGuild.get(interaction.guildId) || {}).lastResult ||
      (await probeWebsite(existing.website));

    await sendMonitorMessage(channel.id, {
      website: existing.website,
      result,
      mode: "setup",
      previousHealth: "unknown",
      failureCount: monitorStateByGuild.get(interaction.guildId)?.consecutiveFailures || 0,
      successCount: monitorStateByGuild.get(interaction.guildId)?.consecutiveSuccesses || 0,
    });

    await interaction.reply({
      content: `Updated alert channel to <#${channel.id}> and posted current status there.`,
      ephemeral: true,
    });
  }
});

client.login(TOKEN);
