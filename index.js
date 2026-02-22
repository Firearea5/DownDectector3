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
const UPDATE_ERROR_MESSAGE =
  "This service is temperarely unavailable due to updates. The estmated waiting time will be 7 minutes. Thnak yoiu for your time: Error Code: X0UP";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const statusByGuild = new Map(); // guildId -> last known up/down

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

async function sendAlert(channelId, isUp, website) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const site = new URL(website);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "DownDetector Monitor" })
      .setTitle(isUp ? "Service Recovered" : "Service Outage Detected")
      .setDescription(
        isUp
          ? "The monitored website is responding again."
          : UPDATE_ERROR_MESSAGE
      )
      .addFields(
        { name: "Website", value: website },
        { name: "Host", value: site.host, inline: true },
        { name: "Status", value: isUp ? "Online" : "Offline", inline: true }
      )
      .setColor(isUp ? 0x2ecc71 : 0xe74c3c)
      .setFooter({ text: "Automatic status alert" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

async function sendCurrentStatus(channelId, isUp, website) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const site = new URL(website);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "DownDetector Monitor" })
      .setTitle("Current Website Status")
      .setDescription(
        isUp
          ? "Monitoring is active and the website is reachable."
          : UPDATE_ERROR_MESSAGE
      )
      .addFields(
        { name: "Website", value: website },
        { name: "Host", value: site.host, inline: true },
        { name: "Status", value: isUp ? "Online" : "Offline", inline: true },
        { name: "Check Interval", value: "Every 60 seconds", inline: true }
      )
      .setColor(isUp ? 0x3498db : 0xf39c12)
      .setFooter({ text: "Initial setup status message" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Failed to send status message:", error);
  }
}

async function probeWebsite(website) {
  try {
    const response = await fetch(website);
    return response.ok;
  } catch {
    return false;
  }
}

async function checkSites() {
  const settings = await all(
    "SELECT guild_id, website, channel_id FROM guild_settings"
  );

  for (const { guild_id: guildId, website, channel_id: channelId } of settings) {
    const isUp = await probeWebsite(website);

    const previous = statusByGuild.get(guildId);
    if (typeof previous === "undefined" && !isUp) {
      await sendAlert(channelId, false, website);
    } else if (typeof previous === "boolean" && previous !== isUp) {
      await sendAlert(channelId, isUp, website);
    }

    statusByGuild.set(guildId, isUp);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommandsForAllGuilds();
  setInterval(checkSites, 60000);
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
    statusByGuild.delete(interaction.guildId);

    const isUp = await probeWebsite(website);
    statusByGuild.set(interaction.guildId, isUp);
    await sendCurrentStatus(channel.id, isUp, website);

    await interaction.reply({
      content: `Setup complete. Monitoring ${website} and sending alerts in <#${channel.id}>. I also posted the current status there.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "change-site") {
    const existing = await get(
      "SELECT guild_id FROM guild_settings WHERE guild_id = ?",
      [interaction.guildId]
    );

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
    statusByGuild.delete(interaction.guildId);

    await interaction.reply({
      content: `Updated website to ${website}.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "change-channel") {
    const existing = await get(
      "SELECT guild_id FROM guild_settings WHERE guild_id = ?",
      [interaction.guildId]
    );

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

    await interaction.reply({
      content: `Updated alert channel to <#${channel.id}>.`,
      ephemeral: true,
    });
  }
});

client.login(TOKEN);
