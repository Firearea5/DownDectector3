const tls = require("tls");
const { ChannelType, Client, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

const TOKEN = process.env.TOKEN;
const db = new sqlite3.Database("./settings.db");
const LOOP_TICK_MS = 2000;
const MAX_BODY = 3000;
const MAINT_MSG = "This service is temperarely unavailable due to updates. The estmated waiting time will be 7 minutes. Thnak yoiu for your time: Error Code: X0UP";
const MAINT_KEYS = ["maintenance", "temporarily unavailable", "update in progress", "updating", "service unavailable"];
const DEF = { interval_sec: 5, timeout_ms: 10000, max_retries: 3, retry_delay_ms: 1200, failure_threshold: 2, recovery_threshold: 2, degraded_latency_ms: 2200, suppression_minutes: 15, health_path: "", expected_text: "", user_agent: "DownDetectorSmartBot/2.0", enabled: 1 };

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const runtime = new Map(); // guildId -> state
const liveMsg = new Map(); // guildId -> message id
const liveUpsertLocks = new Map(); // guildId -> promise chain

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY, website TEXT NOT NULL, channel_id TEXT NOT NULL, status_message_id TEXT,
    interval_sec INTEGER DEFAULT 5, timeout_ms INTEGER DEFAULT 10000, max_retries INTEGER DEFAULT 3, retry_delay_ms INTEGER DEFAULT 1200,
    failure_threshold INTEGER DEFAULT 2, recovery_threshold INTEGER DEFAULT 2, degraded_latency_ms INTEGER DEFAULT 2200,
    suppression_minutes INTEGER DEFAULT 15, health_path TEXT DEFAULT '', expected_text TEXT DEFAULT '', user_agent TEXT DEFAULT 'DownDetectorSmartBot/2.0', enabled INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS check_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, checked_at TEXT NOT NULL, health TEXT NOT NULL,
    http_status INTEGER, latency_ms INTEGER, reason TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT,
    start_health TEXT NOT NULL, end_health TEXT, latest_reason TEXT
  )`);
  const mig = [
    "ALTER TABLE guild_settings ADD COLUMN status_message_id TEXT",
    "ALTER TABLE guild_settings ADD COLUMN interval_sec INTEGER DEFAULT 5",
    "ALTER TABLE guild_settings ADD COLUMN timeout_ms INTEGER DEFAULT 10000",
    "ALTER TABLE guild_settings ADD COLUMN max_retries INTEGER DEFAULT 3",
    "ALTER TABLE guild_settings ADD COLUMN retry_delay_ms INTEGER DEFAULT 1200",
    "ALTER TABLE guild_settings ADD COLUMN failure_threshold INTEGER DEFAULT 2",
    "ALTER TABLE guild_settings ADD COLUMN recovery_threshold INTEGER DEFAULT 2",
    "ALTER TABLE guild_settings ADD COLUMN degraded_latency_ms INTEGER DEFAULT 2200",
    "ALTER TABLE guild_settings ADD COLUMN suppression_minutes INTEGER DEFAULT 15",
    "ALTER TABLE guild_settings ADD COLUMN health_path TEXT DEFAULT ''",
    "ALTER TABLE guild_settings ADD COLUMN expected_text TEXT DEFAULT ''",
    "ALTER TABLE guild_settings ADD COLUMN user_agent TEXT DEFAULT 'DownDetectorSmartBot/2.0'",
    "ALTER TABLE guild_settings ADD COLUMN enabled INTEGER DEFAULT 1",
  ];
  for (const s of mig) db.run(s, (e) => e && !String(e.message).includes("duplicate column name") && console.error(e.message));
});

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function f(e) { if (e) rej(e); else res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shrink = (s, n) => (!s ? "" : (s.length > n ? `${s.slice(0, n)}...` : s));
const admin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const normUrl = (u) => new URL(/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`).toString();
const siteHost = (website) => {
  try {
    return new URL(website).hostname;
  } catch {
    return "Unknown";
  }
};
const siteLogo = (website) => {
  try {
    const host = new URL(website).hostname;
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
  } catch {
    return null;
  }
};
const hColor = (h) => (h === "up" ? 0x2ecc71 : h === "degraded" ? 0xf39c12 : h === "maintenance" ? 0xff8c00 : 0xe74c3c);
const hText = (h) => (h === "up" ? "Online" : h === "degraded" ? "Degraded" : h === "maintenance" ? "Maintenance" : "Offline");
const rank = (h) => (h === "down" ? 3 : h === "maintenance" ? 2 : h === "degraded" ? 1 : 0);
const worse = (a, b) => (rank(b) > rank(a) ? b : a);
const cfg = (r) => ({ ...DEF, ...r, interval_sec: +r.interval_sec, timeout_ms: +r.timeout_ms, max_retries: +r.max_retries, retry_delay_ms: +r.retry_delay_ms, failure_threshold: +r.failure_threshold, recovery_threshold: +r.recovery_threshold, degraded_latency_ms: +r.degraded_latency_ms, suppression_minutes: +r.suppression_minutes, enabled: +r.enabled });
const initState = () => ({ health: "up", fail: 0, last: null, lastAlert: 0, incidentId: null, lastCheck: 0 });

async function certDays(website, timeoutMs) {
  try {
    const u = new URL(website);
    if (u.protocol !== "https:") return null;
    return await new Promise((resolve) => {
      const sock = tls.connect({ host: u.hostname, port: u.port ? +u.port : 443, servername: u.hostname, rejectUnauthorized: false }, () => {
        const c = sock.getPeerCertificate(); sock.end();
        if (!c?.valid_to) return resolve(null);
        resolve(Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400000));
      });
      sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(null); });
      sock.on("error", () => resolve(null));
    });
  } catch { return null; }
}

function classify({ status, body, latency, c, cert }) {
  if (MAINT_KEYS.some((k) => body.toLowerCase().includes(k))) return { health: "maintenance", reason: "Maintenance text detected" };
  if (c.expected_text && !body.toLowerCase().includes(c.expected_text.toLowerCase())) return { health: "down", reason: "Expected text check failed" };
  if (status >= 500 || status === 429) return { health: "down", reason: status === 429 ? "Rate limited (HTTP 429)" : `Server error (HTTP ${status})` };
  if (status >= 400) return { health: "degraded", reason: `Reachable but HTTP ${status}` };
  let health = latency >= c.degraded_latency_ms ? "degraded" : "up";
  let reason = health === "degraded" ? `High latency (${latency}ms)` : "Healthy HTTP response";
  if (typeof cert === "number" && cert <= 7) { health = worse(health, "degraded"); reason = `SSL certificate expires in ${cert} day(s)`; }
  return { health, reason };
}

async function probe(c) {
  const probeUrl = c.health_path ? new URL(c.health_path, c.website).toString() : c.website;
  const cert = await certDays(c.website, c.timeout_ms);
  let out = { health: "down", reason: "Unknown error", statusCode: null, latencyMs: null, attempts: c.max_retries, certDaysLeft: cert, probeUrl };
  for (let i = 1; i <= c.max_retries; i += 1) {
    const t0 = Date.now(); const ctr = new AbortController(); const to = setTimeout(() => ctr.abort(), c.timeout_ms);
    try {
      const r = await fetch(probeUrl, { method: "GET", cache: "no-store", redirect: "follow", headers: { "User-Agent": c.user_agent }, signal: ctr.signal });
      clearTimeout(to);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const texty = ct.includes("text/") || ct.includes("application/json") || ct.includes("application/xml");
      const body = texty ? shrink(await r.text(), MAX_BODY) : "";
      const latency = Date.now() - t0;
      const k = classify({ status: r.status, body, latency, c, cert });
      out = { health: k.health, reason: k.reason, statusCode: r.status, latencyMs: latency, attempts: i, certDaysLeft: cert, probeUrl };
      if (k.health !== "down") return out;
      if (r.status === 429 && i < c.max_retries) {
        const ra = Number(r.headers.get("retry-after") || 0);
        await sleep((Number.isFinite(ra) && ra > 0 ? ra * 1000 : c.retry_delay_ms * 2));
      } else if (i < c.max_retries) await sleep(c.retry_delay_ms);
    } catch (e) {
      clearTimeout(to);
      out = { health: "down", reason: e?.name === "AbortError" ? `Request timed out after ${c.timeout_ms}ms` : (e?.message || "Network error"), statusCode: null, latencyMs: Date.now() - t0, attempts: i, certDaysLeft: cert, probeUrl };
      if (i < c.max_retries) await sleep(c.retry_delay_ms);
    }
  }
  return out;
}

function embed({ c, r, mode, prev, incidentOpenAt }) {
  const host = siteHost(c.website);
  const desc = mode === "live"
    ? `Tracking ${host}\nThis embed is automatically updated!`
    : mode === "setup"
      ? `Monitoring started for ${host}.`
      : (r.health === "maintenance" ? MAINT_MSG : r.health === "down" ? "Service appears unavailable." : r.health === "degraded" ? "Service is reachable but degraded." : "Service recovered.");
  const logo = siteLogo(c.website);
  const e = new EmbedBuilder()
    .setAuthor(logo ? { name: "DownDetector", iconURL: logo } : { name: "DownDetector" })
    .setTitle(mode === "live" ? "Live Service Status" : mode === "setup" ? "Monitor Initialized" : `Service Update: ${host}`)
    .setDescription(desc)
    .addFields(
      { name: "Current Status", value: hText(r.health), inline: true }, { name: "Previous Status", value: hText(prev || "up"), inline: true }, { name: "HTTP", value: r.statusCode ? String(r.statusCode) : "No response", inline: true },
      { name: "Latency", value: r.latencyMs ? `${r.latencyMs}ms` : "n/a", inline: true }, { name: "Attempts", value: `${r.attempts}/${c.max_retries}`, inline: true }, { name: "SSL Expiry", value: typeof r.certDaysLeft === "number" ? `${r.certDaysLeft} day(s)` : "n/a", inline: true },
      { name: "Website", value: c.website }, { name: "Probe URL", value: r.probeUrl },
      { name: "Reason", value: shrink(r.reason, 1024) || "n/a" },
      { name: "Incident", value: incidentOpenAt ? `Open since ${incidentOpenAt}` : "No open incident" }
    )
    .setColor(hColor(r.health))
    .setTimestamp();
  if (logo) e.setThumbnail(logo);
  return e;
}

async function logCheck(gid, r) {
  await run("INSERT INTO check_logs (guild_id, checked_at, health, http_status, latency_ms, reason) VALUES (?, ?, ?, ?, ?, ?)", [gid, new Date().toISOString(), r.health, r.statusCode, r.latencyMs, shrink(r.reason, 1000)]);
}
async function openIncident(gid, health, reason) { const opened = new Date().toISOString(); const x = await run("INSERT INTO incidents (guild_id, opened_at, start_health, latest_reason) VALUES (?, ?, ?, ?)", [gid, opened, health, shrink(reason, 1000)]); return { id: x.lastID, opened }; }
const updateIncident = async (id, reason) => run("UPDATE incidents SET latest_reason = ? WHERE id = ?", [shrink(reason, 1000), id]);
const closeIncident = async (id, reason) => run("UPDATE incidents SET closed_at = ?, end_health = 'up', latest_reason = ? WHERE id = ?", [new Date().toISOString(), shrink(reason, 1000), id]);

async function sendEvent(channelId, e) { try { const ch = await client.channels.fetch(channelId); if (ch?.isTextBased()) await ch.send({ embeds: [e] }); } catch (err) { console.error("event send failed", err); } }
async function upsertLive(gid, channelId, e) {
  let created = false;
  const prev = liveUpsertLocks.get(gid) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    try {
      const ch = await client.channels.fetch(channelId); if (!ch?.isTextBased()) return;
      let mid = liveMsg.get(gid); if (!mid) { const row = await get("SELECT status_message_id FROM guild_settings WHERE guild_id = ?", [gid]); mid = row?.status_message_id || null; }
      if (mid) { try { const m = await ch.messages.fetch(mid); await m.edit({ embeds: [e] }); liveMsg.set(gid, mid); return; } catch { mid = null; } }
      const sent = await ch.send({ embeds: [e] }); liveMsg.set(gid, sent.id); await run("UPDATE guild_settings SET status_message_id = ? WHERE guild_id = ?", [sent.id, gid]); created = true;
    } catch (err) { console.error("live upsert failed", err); }
  });
  liveUpsertLocks.set(gid, next);
  try {
    await next;
  } finally {
    if (liveUpsertLocks.get(gid) === next) liveUpsertLocks.delete(gid);
  }
  return { created };
}

async function evaluate(row) {
  const c = cfg(row); const gid = c.guild_id; const s = runtime.get(gid) || initState();
  const r = await probe(c); const prev = s.health; s.last = r;
  if (r.health === "up") s.fail = 0;
  else s.fail += 1;
  let next = prev;
  if (prev === "up" && r.health !== "up" && s.fail >= c.failure_threshold) next = r.health;
  if (prev !== "up" && r.health === "up") next = "up";
  if (prev !== "up" && r.health !== "up" && r.health !== prev) next = r.health;
  const changed = next !== prev; s.health = next;
  const suppressMs = c.suppression_minutes * 60000; const now = Date.now();
  const periodic = s.health !== "up" && !changed && now - s.lastAlert >= suppressMs;

  let openAt = null;
  if (changed && s.health !== "up" && !s.incidentId) { const o = await openIncident(gid, s.health, r.reason); s.incidentId = o.id; openAt = o.opened; }
  else if (changed && s.health === "up" && s.incidentId) { await closeIncident(s.incidentId, r.reason); s.incidentId = null; }
  else if (s.incidentId) { await updateIncident(s.incidentId, r.reason); const x = await get("SELECT opened_at FROM incidents WHERE id = ?", [s.incidentId]); openAt = x?.opened_at || null; }

  const live = await upsertLive(gid, c.channel_id, embed({ c, r: { ...r, health: s.health }, mode: "live", prev, incidentOpenAt: openAt }));
  if ((changed || periodic) && !live.created) { await sendEvent(c.channel_id, embed({ c, r: { ...r, health: s.health }, mode: "event", prev, incidentOpenAt: openAt })); s.lastAlert = now; }
  s.lastCheck = now; runtime.set(gid, s); await logCheck(gid, { ...r, health: s.health });
}

async function monitorTick() {
  const rows = await all("SELECT * FROM guild_settings WHERE enabled = 1");
  for (const row of rows) {
    const c = cfg(row); const s = runtime.get(c.guild_id) || initState();
    if (Date.now() - s.lastCheck < c.interval_sec * 1000) continue;
    try { await evaluate(c); } catch (e) { console.error("tick failed", c.guild_id, e.message); }
  }
}

async function registerGuildCommands(g) {
  const commands = [
    new SlashCommandBuilder().setName("setup").setDescription("Configure website monitoring").addStringOption((o) => o.setName("website").setDescription("Base website URL").setRequired(true)).addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
    new SlashCommandBuilder().setName("change-site").setDescription("Change monitored site").addStringOption((o) => o.setName("website").setDescription("New website URL").setRequired(true)),
    new SlashCommandBuilder().setName("change-channel").setDescription("Change monitor channel").addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
    new SlashCommandBuilder().setName("site-config").setDescription("Update smart monitor settings")
      .addIntegerOption((o) => o.setName("interval_sec").setDescription("5-300").setMinValue(5).setMaxValue(300))
      .addIntegerOption((o) => o.setName("timeout_ms").setDescription("1000-30000").setMinValue(1000).setMaxValue(30000))
      .addIntegerOption((o) => o.setName("max_retries").setDescription("1-5").setMinValue(1).setMaxValue(5))
      .addIntegerOption((o) => o.setName("retry_delay_ms").setDescription("200-5000").setMinValue(200).setMaxValue(5000))
      .addIntegerOption((o) => o.setName("failure_threshold").setDescription("1-5").setMinValue(1).setMaxValue(5))
      .addIntegerOption((o) => o.setName("recovery_threshold").setDescription("1-5").setMinValue(1).setMaxValue(5))
      .addIntegerOption((o) => o.setName("degraded_latency_ms").setDescription("300-20000").setMinValue(300).setMaxValue(20000))
      .addIntegerOption((o) => o.setName("suppression_minutes").setDescription("1-180").setMinValue(1).setMaxValue(180))
      .addStringOption((o) => o.setName("health_path").setDescription("For example /health"))
      .addStringOption((o) => o.setName("expected_text").setDescription("Required response text"))
      .addStringOption((o) => o.setName("user_agent").setDescription("Request user-agent"))
      .addBooleanOption((o) => o.setName("enabled").setDescription("Enable/disable monitor")),
    new SlashCommandBuilder().setName("status").setDescription("Show current status"),
    new SlashCommandBuilder().setName("history").setDescription("Show recent incidents").addIntegerOption((o) => o.setName("limit").setDescription("1-10").setMinValue(1).setMaxValue(10)),
  ].map((x) => x.toJSON());
  await g.commands.set(commands);
}

async function registerAllCommands() {
  const gs = await client.guilds.fetch();
  await Promise.all(gs.map(async (og) => registerGuildCommands(await og.fetch())));
}

async function getSetup(gid) { const row = await get("SELECT * FROM guild_settings WHERE guild_id = ?", [gid]); return row ? cfg(row) : null; }
async function sendSetup(gid, c) {
  const r = await probe(c); const s = initState(); s.health = r.health; s.last = r; s.fail = r.health === "up" ? 0 : c.failure_threshold; s.lastCheck = Date.now(); s.lastAlert = Date.now(); runtime.set(gid, s);
  await upsertLive(gid, c.channel_id, embed({ c, r, mode: "live", prev: "up", incidentOpenAt: null }));
}

client.once("ready", async () => { console.log(`Logged in as ${client.user.tag}`); await registerAllCommands(); setInterval(monitorTick, LOOP_TICK_MS); await monitorTick(); });
client.on("guildCreate", async (g) => registerGuildCommands(g));

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand() || !i.guildId) return;
  if (!admin(i)) return i.reply({ content: "You must have Administrator permission to use monitor commands.", ephemeral: true });

  if (i.commandName === "setup") {
    const channel = i.options.getChannel("channel", true); let website;
    try { website = normUrl(i.options.getString("website", true)); } catch { return i.reply({ content: "Invalid website URL.", ephemeral: true }); }
    await run(`INSERT INTO guild_settings (guild_id, website, channel_id, status_message_id, interval_sec, timeout_ms, max_retries, retry_delay_ms, failure_threshold, recovery_threshold, degraded_latency_ms, suppression_minutes, health_path, expected_text, user_agent, enabled)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET website = excluded.website, channel_id = excluded.channel_id, status_message_id = NULL`,
    [i.guildId, website, channel.id, DEF.interval_sec, DEF.timeout_ms, DEF.max_retries, DEF.retry_delay_ms, DEF.failure_threshold, DEF.recovery_threshold, DEF.degraded_latency_ms, DEF.suppression_minutes, DEF.health_path, DEF.expected_text, DEF.user_agent, DEF.enabled]);
    liveMsg.delete(i.guildId); await sendSetup(i.guildId, await getSetup(i.guildId));
    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "DownDetector" })
          .setTitle("Setup Complete")
          .setDescription("Monitoring has been enabled for your server.")
          .addFields(
            { name: "Website", value: website },
            { name: "Channel", value: `<#${channel.id}>` },
            { name: "Live Embed", value: "This embed is automatically updated!" }
          )
          .setColor(0x2ecc71)
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  if (i.commandName === "change-site") {
    const c = await getSetup(i.guildId); if (!c) return i.reply({ content: "Run /setup first.", ephemeral: true });
    let website; try { website = normUrl(i.options.getString("website", true)); } catch { return i.reply({ content: "Invalid website URL.", ephemeral: true }); }
    await run("UPDATE guild_settings SET website = ?, status_message_id = NULL WHERE guild_id = ?", [website, i.guildId]); liveMsg.delete(i.guildId);
    await sendSetup(i.guildId, await getSetup(i.guildId)); return i.reply({ content: `Website updated to ${website}.`, ephemeral: true });
  }

  if (i.commandName === "change-channel") {
    const c = await getSetup(i.guildId); if (!c) return i.reply({ content: "Run /setup first.", ephemeral: true });
    const channel = i.options.getChannel("channel", true);
    await run("UPDATE guild_settings SET channel_id = ?, status_message_id = NULL WHERE guild_id = ?", [channel.id, i.guildId]); liveMsg.delete(i.guildId);
    await sendSetup(i.guildId, await getSetup(i.guildId)); return i.reply({ content: `Channel updated to <#${channel.id}>.`, ephemeral: true });
  }

  if (i.commandName === "site-config") {
    const c = await getSetup(i.guildId); if (!c) return i.reply({ content: "Run /setup first.", ephemeral: true });
    const patch = { interval_sec: i.options.getInteger("interval_sec"), timeout_ms: i.options.getInteger("timeout_ms"), max_retries: i.options.getInteger("max_retries"), retry_delay_ms: i.options.getInteger("retry_delay_ms"), failure_threshold: i.options.getInteger("failure_threshold"), recovery_threshold: i.options.getInteger("recovery_threshold"), degraded_latency_ms: i.options.getInteger("degraded_latency_ms"), suppression_minutes: i.options.getInteger("suppression_minutes"), health_path: i.options.getString("health_path"), expected_text: i.options.getString("expected_text"), user_agent: i.options.getString("user_agent"), enabled: i.options.getBoolean("enabled") };
    const keys = Object.keys(patch).filter((k) => patch[k] !== null); if (!keys.length) return i.reply({ content: "Set at least one option.", ephemeral: true });
    await run(`UPDATE guild_settings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE guild_id = ?`, [...keys.map((k) => patch[k]), i.guildId]);
    await sendSetup(i.guildId, await getSetup(i.guildId)); return i.reply({ content: "Site config updated.", ephemeral: true });
  }

  if (i.commandName === "status") {
    const c = await getSetup(i.guildId); if (!c) return i.reply({ content: "Run /setup first.", ephemeral: true });
    const s = runtime.get(i.guildId) || initState(); const r = s.last || await probe(c);
    return i.reply({ embeds: [embed({ c, r: { ...r, health: s.health || r.health }, mode: "event", prev: s.health || "up", incidentOpenAt: null })], ephemeral: true });
  }

  if (i.commandName === "history") {
    const c = await getSetup(i.guildId); if (!c) return i.reply({ content: "Run /setup first.", ephemeral: true });
    const limit = i.options.getInteger("limit") || 5;
    const rows = await all("SELECT id, opened_at, closed_at, start_health, end_health, latest_reason FROM incidents WHERE guild_id = ? ORDER BY id DESC LIMIT ?", [i.guildId, limit]);
    if (!rows.length) return i.reply({ content: "No incidents logged yet.", ephemeral: true });
    const lines = rows.map((r) => `#${r.id} ${r.start_health}->${r.end_health || "ongoing"} | opened ${r.opened_at} | ${r.closed_at ? `closed ${r.closed_at}` : "open"} | ${shrink(r.latest_reason || "", 100)}`);
    return i.reply({ content: `Recent incidents:\n${lines.join("\n")}`, ephemeral: true });
  }
});

client.login(TOKEN);
