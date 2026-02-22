const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = "1474922121447608463";

const sites = [
  "https://www.youtube.com/",
  "https://roblox.com",
  "https://www.twitch.tv/",
  "https://www.facebook.com/",
  "https://www.x.com/",
  "https://www.instagram.com/",
  "https://www.linkedin.com/",
  "https://www.reddit.com/",
  "https://www.netflix.com/",
  "https://www.spotify.com/",
  "https://test.com/isntevenrunning"
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let status = {}; // track up/down state

async function checkSites() {
  for (const url of sites) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        if (status[url] === false) {
          status[url] = true;
          alertRecovered(url);
        }
      } else {
        if (status[url] !== false) {
          status[url] = false;
          alertDown(url);
        }
      }

    } catch {
      if (status[url] !== false) {
        status[url] = false;
        alertDown(url);
      }
    }
  }
}

function alertDown(url) {
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("🚨 Website Down")
    .setDescription(`${url} is not responding.`)
    .setColor(0xff0000)
    .setTimestamp();

  channel.send({ embeds: [embed] });
}

function alertRecovered(url) {
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("✅ Website Recovered")
    .setDescription(`${url} is back online.`)
    .setColor(0x00ff00)
    .setTimestamp();

  channel.send({ embeds: [embed] });
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  setInterval(checkSites, 60000);
  checkSites();
});

client.login(TOKEN);