// voiceMilestoneService.js
//
// Rewards members with tiered roles based on the total time they spend in voice
// channels. Time is accumulated per member (guild-scoped). Whenever a member
// crosses a milestone threshold the matching role is granted and every other
// milestone role is removed, so a member always holds at most one voice tier.

import { logger } from '../utils/logger.js';
import { getColor } from '../config/bot.js';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { renderVoiceMilestoneCard, renderVoiceLeaderboardCard } from './voiceMilestoneCard.js';
import {
  getVoiceMilestoneConfigKey,
  getVoiceMilestoneUserKey,
  getVoiceMilestoneUsersPrefix,
  getVoiceMilestonePanelKey,
} from '../utils/database/keys.js';

const HOUR_MS = 60 * 60 * 1000;
const MAX_MILESTONES = 25;
const MAX_LABEL_LENGTH = 100;

/**
 * Ready-made milestone ladder for the Manay Society server. Role IDs are left
 * empty and filled in by an administrator through `/voicemilestone setrole`.
 */
export const VOICE_MILESTONE_PRESET = Object.freeze([
  { hours: 5, label: 'New Face' },
  { hours: 10, label: 'Familiar Face' },
  { hours: 25, label: 'Lounge Regular' },
  { hours: 50, label: 'Society Socialite' },
  { hours: 100, label: 'Manay Insider' },
  { hours: 200, label: 'Inner Circle' },
  { hours: 350, label: 'Society Pillar' },
  { hours: 500, label: 'Manay Icon' },
  { hours: 750, label: 'Society Legend' },
  { hours: 1000, label: 'Hall of Fame' },
]);

// In-memory join timestamps, keyed `${guildId}:${userId}`.
const activeSessions = new Map();

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function hoursToMs(hours) {
  return Math.max(0, Number(hours) || 0) * HOUR_MS;
}

export function hoursToMilliseconds(hours) {
  return hoursToMs(hours);
}

/** Compact "3h 12m" duration for a millisecond value. */
export function formatVoiceDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/** Validated, de-duplicated, ascending milestone list. */
export function normalizeMilestones(list) {
  if (!Array.isArray(list)) return [];

  const byHours = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;

    const hours = Math.floor(Number(entry.hours));
    if (!Number.isFinite(hours) || hours <= 0) continue;

    const label = typeof entry.label === 'string' && entry.label.trim()
      ? entry.label.trim().slice(0, MAX_LABEL_LENGTH)
      : `${hours}h`;

    byHours.set(hours, {
      hours,
      label,
      roleId: entry.roleId ? String(entry.roleId) : null,
    });
  }

  return [...byHours.values()]
    .sort((a, b) => a.hours - b.hours)
    .slice(0, MAX_MILESTONES);
}

export async function getVoiceMilestoneConfig(client, guildId) {
  if (!client?.db) {
    return { enabled: false, announcementChannelId: null, milestones: [] };
  }

  try {
    const raw = await client.db.get(getVoiceMilestoneConfigKey(guildId), {});
    const base = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: base.enabled === true,
      announcementChannelId: base.announcementChannelId ? String(base.announcementChannelId) : null,
      milestones: normalizeMilestones(base.milestones),
    };
  } catch (error) {
    logger.error(`Error reading voice milestone config for guild ${guildId}:`, error);
    return { enabled: false, announcementChannelId: null, milestones: [] };
  }
}

export async function saveVoiceMilestoneConfig(client, guildId, config) {
  const normalized = {
    enabled: config?.enabled === true,
    announcementChannelId: config?.announcementChannelId ? String(config.announcementChannelId) : null,
    milestones: normalizeMilestones(config?.milestones),
  };

  await client.db.set(getVoiceMilestoneConfigKey(guildId), normalized);
  return normalized;
}

export async function getVoiceMilestoneData(client, guildId, userId) {
  const empty = { userId: String(userId), totalMs: 0, updatedAt: null };
  if (!client?.db) return empty;

  try {
    const raw = await client.db.get(getVoiceMilestoneUserKey(guildId, userId), null);
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
      userId: String(userId),
      totalMs: Math.max(0, Math.floor(Number(data.totalMs) || 0)),
      updatedAt: Number(data.updatedAt) || null,
    };
  } catch (error) {
    logger.error(`Error reading voice milestone data for ${guildId}:${userId}:`, error);
    return empty;
  }
}

async function addVoiceTime(client, guildId, userId, deltaMs) {
  const current = await getVoiceMilestoneData(client, guildId, userId);
  const totalMs = current.totalMs + Math.max(0, Math.floor(deltaMs));

  const data = { userId: String(userId), totalMs, updatedAt: Date.now() };
  await client.db.set(getVoiceMilestoneUserKey(guildId, userId), data);
  return data;
}

export async function resetVoiceMilestoneData(client, guildId, userId) {
  activeSessions.delete(sessionKey(guildId, userId));
  await client.db.delete(getVoiceMilestoneUserKey(guildId, userId));
}

/** Resolve which milestone is currently held and which one comes next. */
export function getMilestoneProgress(totalMs, milestones) {
  const sorted = normalizeMilestones(milestones);

  let current = null;
  let next = null;

  for (const milestone of sorted) {
    if (totalMs >= hoursToMs(milestone.hours)) {
      current = milestone;
    } else {
      next = milestone;
      break;
    }
  }

  return { current, next, sorted };
}

/** Milliseconds accumulated in the current, not-yet-committed voice session. */
export function getActiveSessionMs(guildId, userId) {
  const startedAt = activeSessions.get(sessionKey(guildId, userId));
  if (startedAt == null) return 0;
  return Math.max(0, Date.now() - startedAt);
}

/** Compute this member's global rank (1 = highest total voice) within the guild. */
export async function getVoiceMilestoneRank(client, guildId, userId, totalMs) {
  if (!client?.db) return null;

  try {
    const prefix = getVoiceMilestoneUsersPrefix(guildId);
    const keys = await client.db.list(prefix);
    let rank = 1;

    for (const key of keys) {
      const entryUserId = key.slice(prefix.length);
      if (!entryUserId || entryUserId === userId) continue;

      const raw = await client.db.get(key, null);
      const ms = Math.max(0, Math.floor(Number(raw?.totalMs) || 0));
      if (ms > totalMs) rank += 1;
    }

    return rank;
  } catch (error) {
    logger.debug(`Failed to compute voice milestone rank for ${guildId}:${userId}:`, error);
    return null;
  }
}

async function syncMemberMilestones(client, guild, userId, totalMs, config) {
  const configured = config.milestones.filter((m) => m.roleId);
  if (configured.length === 0) {
    return { granted: null, removed: [] };
  }

  const me = guild.members.me;
  if (!me) {
    return { granted: null, removed: [] };
  }

  let member = null;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    member = null;
  }
  if (!member) {
    return { granted: null, removed: [] };
  }

  const reached = configured.filter((m) => totalMs >= hoursToMs(m.hours));
  const target = reached.length > 0 ? reached[reached.length - 1] : null;

  let granted = null;
  const removed = [];

  for (const milestone of configured) {
    const role = guild.roles.cache.get(milestone.roleId)
      || await guild.roles.fetch(milestone.roleId).catch(() => null);

    // Skip roles that no longer exist or sit above the bot's highest role.
    if (!role || role.position >= me.roles.highest.position) continue;

    const isTarget = Boolean(target && target.hours === milestone.hours);

    if (isTarget) {
      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role, 'Voice milestone reached');
          granted = role.id;
        } catch (error) {
          logger.debug(`Failed to grant voice milestone role ${role.id} to ${userId}:`, error);
        }
      }
    } else if (member.roles.cache.has(role.id)) {
      try {
        await member.roles.remove(role, 'Voice milestone tier change');
        removed.push(role.id);
      } catch (error) {
        logger.debug(`Failed to remove voice milestone role ${role.id} from ${userId}:`, error);
      }
    }
  }

  return { granted, removed };
}

function formatAnnouncementDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours && minutes) return `${hours} jam ${minutes} menit`;
  if (hours) return `${hours} jam`;
  return `${minutes} menit`;
}

async function postMilestoneAnnouncement(
  client,
  guild,
  userId,
  totalMs,
  milestone,
  config,
  { isTest = false, fallbackMember = null } = {},
) {
  if (!config.announcementChannelId) return { ok: false, reason: 'channel_not_set' };

  try {
    const channel = guild.channels.cache.get(config.announcementChannelId)
      || await guild.channels.fetch(config.announcementChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      return { ok: false, reason: 'channel_unavailable' };
    }

    const member = fallbackMember
      || guild.members.cache.get(userId)
      || await guild.members.fetch(userId).catch(() => null);
    if (!member) return { ok: false, reason: 'member_unavailable' };
    const role = milestone.roleId ? guild.roles.cache.get(milestone.roleId) : null;
    const next = config.milestones.find((entry) => entry.hours > milestone.hours);
    const embed = new EmbedBuilder()
      .setColor(role?.color || 0xD6B15E)
      .setTitle(isTest ? '🧪 TEST · VOICE MILESTONE' : '🎙️ VOICE MILESTONE')
      .setDescription(
        `${isTest ? 'Preview:' : 'Selamat!'} Kamu mencapai **${role?.name || milestone.label}** setelah ` +
        `**${formatAnnouncementDuration(totalMs)}** di voice channel.`,
      )
      .addFields(
        { name: 'Total Voice', value: formatAnnouncementDuration(totalMs), inline: true },
        {
          name: 'Target Berikutnya',
          value: next ? `**${next.label}** (${next.hours} jam)` : '🏆 Tier tertinggi tercapai!',
          inline: true,
        },
      )
      .setFooter({
        text: isTest ? 'Manay Society · Test preview, role dan progres tidak berubah' : 'Manay Society',
      });

    let cardBuffer = null;
    try {
      const rank = await getVoiceMilestoneRank(client, guild.id, userId, totalMs);
      cardBuffer = await renderVoiceMilestoneCard({
        member,
        milestone,
        next,
        totalMs,
        roleColor: role?.color,
        isTest,
        rank,
      });
      embed.setImage('attachment://voice-milestone.png');
    } catch (error) {
      logger.warn(`Failed to render voice milestone card for ${userId}:`, error);
    }

    const payload = {
      content: isTest ? '🧪 Ini preview pengumuman; role dan progres tidak diubah.' : `<@${userId}>`,
      embeds: [embed],
      allowedMentions: { users: isTest ? [] : [userId] },
    };
    if (cardBuffer) {
      payload.files = [new AttachmentBuilder(cardBuffer, { name: 'voice-milestone.png' })];
    }
    await channel.send(payload);
    return { ok: true, channelId: channel.id, imageGenerated: Boolean(cardBuffer) };
  } catch (error) {
    logger.warn(`Failed to announce voice milestone for ${userId} in guild ${guild.id}:`, error);
    return { ok: false, reason: 'send_failed' };
  }
}

export async function sendVoiceMilestoneTestAnnouncement(
  client,
  guild,
  userId,
  hours = null,
  fallbackMember = null,
) {
  const config = await getVoiceMilestoneConfig(client, guild.id);
  const milestone = hours == null
    ? config.milestones[0]
    : config.milestones.find((entry) => entry.hours === hours);

  if (!milestone) return { ok: false, reason: 'milestone_not_found' };

  return postMilestoneAnnouncement(
    client,
    guild,
    userId,
    hoursToMs(milestone.hours),
    milestone,
    config,
    { isTest: true, fallbackMember },
  );
}

async function commitSession(client, guildId, userId, { resume = false } = {}) {
  const key = sessionKey(guildId, userId);
  const startedAt = activeSessions.get(key);
  if (startedAt == null) return null;

  const config = await getVoiceMilestoneConfig(client, guildId);
  if (!config.enabled) {
    activeSessions.delete(key);
    return null;
  }

  const now = Date.now();
  const deltaMs = now - startedAt;

  if (resume) {
    activeSessions.set(key, now);
  } else {
    activeSessions.delete(key);
  }

  if (deltaMs <= 0) return null;

  const data = await addVoiceTime(client, guildId, userId, deltaMs);

  const guild = client.guilds?.cache?.get(guildId);
  const roles = guild
    ? await syncMemberMilestones(client, guild, userId, data.totalMs, config)
    : { granted: null, removed: [] };

  if (guild && roles.granted) {
    const milestone = config.milestones.find((entry) => entry.roleId === roles.granted);
    if (milestone) {
      await postMilestoneAnnouncement(client, guild, userId, data.totalMs, milestone, config);
    }
  }

  return { guildId, userId, totalMs: data.totalMs, deltaMs, ...roles };
}

export async function trackVoiceJoin(client, guildId, userId) {
  const config = await getVoiceMilestoneConfig(client, guildId);
  const key = sessionKey(guildId, userId);

  if (!config.enabled) {
    activeSessions.delete(key);
    return;
  }

  if (!activeSessions.has(key)) {
    activeSessions.set(key, Date.now());
  }
}

export async function trackVoiceLeave(client, guildId, userId) {
  return commitSession(client, guildId, userId, { resume: false });
}

export async function trackVoiceMove(client, guildId, userId) {
  const config = await getVoiceMilestoneConfig(client, guildId);
  const key = sessionKey(guildId, userId);

  if (!config.enabled) {
    activeSessions.delete(key);
    return null;
  }

  const result = await commitSession(client, guildId, userId, { resume: true });

  // Keep counting while the member stays connected in the new channel.
  if (!activeSessions.has(key)) {
    activeSessions.set(key, Date.now());
  }

  return result;
}

/** Periodic commit so long voice sessions still award milestones. */
export async function flushVoiceSessions(client) {
  const results = [];

  for (const key of [...activeSessions.keys()]) {
    const [guildId, userId] = key.split(':');
    if (!guildId || !userId) {
      activeSessions.delete(key);
      continue;
    }

    try {
      const result = await commitSession(client, guildId, userId, { resume: true });
      if (result) results.push(result);
    } catch (error) {
      logger.error(`Failed to flush voice milestone session ${key}:`, error);
    }
  }

  return results;
}

/** Re-apply milestone roles for one member based on their recorded time. */
export async function applyMilestonesForMember(client, guildId, userId) {
  const config = await getVoiceMilestoneConfig(client, guildId);
  const guild = client.guilds?.cache?.get(guildId);
  if (!guild) {
    return { granted: null, removed: [] };
  }

  const data = await getVoiceMilestoneData(client, guildId, userId);
  return syncMemberMilestones(client, guild, userId, data.totalMs, config);
}

/** Re-apply milestone roles for every member tracked in the guild. */
export async function recheckAllMembers(client, guildId) {
  const config = await getVoiceMilestoneConfig(client, guildId);
  const guild = client.guilds?.cache?.get(guildId);
  if (!guild || config.milestones.filter((m) => m.roleId).length === 0) {
    return { checked: 0 };
  }

  const prefix = getVoiceMilestoneUsersPrefix(guildId);
  const keys = await client.db.list(prefix);

  let checked = 0;
  for (const key of keys) {
    const userId = key.slice(prefix.length);
    if (!userId) continue;

    const data = await getVoiceMilestoneData(client, guildId, userId);
    await syncMemberMilestones(client, guild, userId, data.totalMs, config);
    checked += 1;
  }

  return { checked };
}

/**
 * Every tracked member in the guild, ranked by total voice time. Current,
 * not-yet-committed sessions are included so the ranking stays live.
 */
export async function getVoiceMilestoneLeaderboard(client, guildId) {
  if (!client?.db) return [];

  try {
    const prefix = getVoiceMilestoneUsersPrefix(guildId);
    const keys = await client.db.list(prefix);
    const entries = [];

    for (const key of keys) {
      const userId = key.slice(prefix.length);
      if (!userId) continue;

      const raw = await client.db.get(key, null);
      const storedMs = Math.max(0, Math.floor(Number(raw?.totalMs) || 0));
      const totalMs = storedMs + getActiveSessionMs(guildId, userId);
      if (totalMs <= 0) continue;

      entries.push({ userId, totalMs });
    }

    entries.sort((a, b) => b.totalMs - a.totalMs || a.userId.localeCompare(b.userId));
    return entries;
  } catch (error) {
    logger.error(`Failed to build voice milestone leaderboard for guild ${guildId}:`, error);
    return [];
  }
}

const LEADERBOARD_SIZE = 10;

/** Payload (embeds + image attachment) for the live voice leaderboard. */
export async function buildVoiceLeaderboardEmbed(client, guild, { viewerId = null } = {}) {
  const config = await getVoiceMilestoneConfig(client, guild.id);
  const entries = await getVoiceMilestoneLeaderboard(client, guild.id);
  const top = entries.slice(0, LEADERBOARD_SIZE);

  // Resolve member display names + avatar URLs for the rendered card.
  const members = [];
  for (const entry of top) {
    let member = guild.members.cache.get(entry.userId);
    if (!member) member = await guild.members.fetch(entry.userId).catch(() => null);
    members.push({
      userId: entry.userId,
      totalMs: entry.totalMs,
      displayName: member?.displayName || member?.user?.username || entry.userId,
      avatarURL: member?.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null,
    });
  }

  let viewer = null;
  if (viewerId) {
    const index = entries.findIndex((entry) => entry.userId === String(viewerId));
    if (index >= 0) {
      viewer = { rank: index + 1, totalMs: entries[index].totalMs };
    }
  }

  const embed = new EmbedBuilder()
    .setColor(config.enabled ? getColor('success') : getColor('warning'))
    .setTitle('Voice Leaderboard');

  if (entries.length === 0) {
    embed.setDescription('Belum ada data voice yang tercatat.');
  }

  if (viewer) {
    embed.addFields({
      name: 'Rank Kamu',
      value: `#${viewer.rank} · ${formatVoiceDuration(viewer.totalMs)}`,
      inline: true,
    });
  }
  embed.addFields({ name: 'Member Terlacak', value: String(entries.length), inline: true });

  let cardBuffer = null;
  try {
    cardBuffer = await renderVoiceLeaderboardCard({
      members,
      viewer,
      memberCount: entries.length,
      configEnabled: config.enabled,
    });
  } catch (error) {
    logger.warn(`Failed to render voice leaderboard card for guild ${guild.id}:`, error);
  }

  if (cardBuffer) {
    embed.setImage('attachment://voice-leaderboard.png');
  }

  const payload = { embeds: [embed] };
  if (cardBuffer) {
    payload.files = [new AttachmentBuilder(cardBuffer, { name: 'voice-leaderboard.png' })];
  }
  return payload;
}

export async function getVoiceMilestonePanel(client, guildId) {
  const empty = { channelId: null, messageId: null };
  if (!client?.db) return empty;

  try {
    const raw = await client.db.get(getVoiceMilestonePanelKey(guildId), null);
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
      channelId: data.channelId ? String(data.channelId) : null,
      messageId: data.messageId ? String(data.messageId) : null,
    };
  } catch (error) {
    logger.error(`Failed to read voice milestone panel for guild ${guildId}:`, error);
    return empty;
  }
}

export async function clearVoiceMilestonePanel(client, guildId) {
  try {
    await client.db.delete(getVoiceMilestonePanelKey(guildId));
  } catch (error) {
    logger.warn(`Failed to clear voice milestone panel for guild ${guildId}:`, error);
  }
}

/** Post a live leaderboard panel to a channel and remember it for auto-refresh. */
export async function postVoiceLeaderboardPanel(client, guild, channelId) {
  const existing = await getVoiceMilestonePanel(client, guild.id);
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);

  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
    return { ok: false, reason: 'channel_unavailable' };
  }

  let message;
  try {
    message = await channel.send(await buildVoiceLeaderboardEmbed(client, guild));
  } catch (error) {
    logger.warn(`Failed to post voice leaderboard panel in guild ${guild.id}:`, error);
    return { ok: false, reason: 'send_failed' };
  }

  // Remove the previous panel if it lived somewhere else.
  if (existing.channelId && existing.messageId
    && (existing.channelId !== channel.id || existing.messageId !== message.id)) {
    const oldChannel = guild.channels.cache.get(existing.channelId)
      || await guild.channels.fetch(existing.channelId).catch(() => null);
    const oldMessage = await oldChannel?.messages?.fetch(existing.messageId).catch(() => null);
    if (oldMessage) await oldMessage.delete().catch(() => {});
  }

  await client.db.set(getVoiceMilestonePanelKey(guild.id), {
    channelId: channel.id,
    messageId: message.id,
  });

  return { ok: true, channelId: channel.id, messageId: message.id };
}

/** Refresh every stored live leaderboard panel. Panels whose message was deleted are dropped. */
export async function refreshVoiceLeaderboardPanels(client) {
  if (!client?.db) return { refreshed: 0 };

  let refreshed = 0;
  for (const guild of client.guilds?.cache?.values?.() ?? []) {
    const panel = await getVoiceMilestonePanel(client, guild.id);
    if (!panel.channelId || !panel.messageId) continue;

    try {
      const channel = guild.channels.cache.get(panel.channelId)
        || await guild.channels.fetch(panel.channelId).catch(() => null);
      if (!channel?.isTextBased?.()) {
        await clearVoiceMilestonePanel(client, guild.id);
        continue;
      }

      const message = await channel.messages.fetch(panel.messageId).catch(() => null);
      if (!message) {
        // Message was deleted manually — stop tracking it.
        await clearVoiceMilestonePanel(client, guild.id);
        continue;
      }

      await message.edit(await buildVoiceLeaderboardEmbed(client, guild));
      refreshed += 1;
    } catch (error) {
      logger.warn(`Failed to refresh voice leaderboard panel for guild ${guild.id}:`, error);
    }
  }

  return { refreshed };
}

export default {
  VOICE_MILESTONE_PRESET,
  normalizeMilestones,
  formatVoiceDuration,
  getVoiceMilestoneConfig,
  saveVoiceMilestoneConfig,
  getVoiceMilestoneData,
  getMilestoneProgress,
  getVoiceMilestoneRank,
  sendVoiceMilestoneTestAnnouncement,
  resetVoiceMilestoneData,
  trackVoiceJoin,
  trackVoiceLeave,
  trackVoiceMove,
  flushVoiceSessions,
  applyMilestonesForMember,
  recheckAllMembers,
  getActiveSessionMs,
  getVoiceMilestoneLeaderboard,
  buildVoiceLeaderboardEmbed,
  getVoiceMilestonePanel,
  clearVoiceMilestonePanel,
  postVoiceLeaderboardPanel,
  refreshVoiceLeaderboardPanels,
};
