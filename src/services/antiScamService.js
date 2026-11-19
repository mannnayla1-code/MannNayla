// services/antiScamService.js
//
// Anti-Scam Protection: mendeteksi pesan scam (foto, file, link phishing),
// menghapusnya, memperingatkan pengirim, mencatat ke channel khusus, dan
// menerapkan timeout otomatis untuk pelanggar berulang.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { createEmbed } from '../utils/embeds.js';
import { getGuildConfig, patchGuildConfig } from './config/guildConfig.js';
import {
  extractUrls,
  analyzeLink,
  analyzeAttachment,
  analyzeImageBuffer,
  isImageAttachment,
  HASH_THRESHOLD_DEFAULT,
} from '../utils/antiScam.js';

export const POLICE_EMOJI = '<a:Policecarlight:1572935642751705159>';

export const SCAM_TYPES = {
  photo: {
    key: 'photo',
    label: 'Photo Scam',
    description: (count) =>
      `Foto {user} scam terdeteksi (${count} foto) dan udah dihapus. Jangan sampai member lain kena tipu`,
  },
  file: {
    key: 'file',
    label: 'Suspicious File',
    description: (count) =>
      `File {user} mencurigakan terdeteksi (${count} file) dan udah dihapus. Jangan sembarangan buka file yang gak jelas`,
  },
  link: {
    key: 'link',
    label: 'Discord Phishing',
    description: (count) =>
      `Link {user} Discord phising terdeteksi (${count} link) dan udah dihapus. Jangan asal klik link yang gak jelas`,
  },
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const DEFAULT_CONFIG = {
  enabled: true,
  logChannelId: null,
  deleteMessage: true,
  warnUser: true,
  notifyChannel: true,
  timeoutOnRepeat: true,
  timeoutThreshold: 3,
  timeoutDurationMinutes: 10,
  strikeWindowHours: 24,
  modules: { photo: true, file: true, link: true },
  knownScamHashes: [],
  ignoredChannels: [],
  ignoredRoles: [],
};

// Strike tracker in-memory: `${guildId}:${userId}` → daftar timestamp.
const strikeStore = new Map();

function strikeKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const modules = config.modules && typeof config.modules === 'object' ? config.modules : {};
  return {
    ...DEFAULT_CONFIG,
    ...config,
    modules: {
      photo: modules.photo !== false,
      file: modules.file !== false,
      link: modules.link !== false,
    },
    knownScamHashes: Array.isArray(config.knownScamHashes) ? config.knownScamHashes : [],
    ignoredChannels: Array.isArray(config.ignoredChannels) ? config.ignoredChannels : [],
    ignoredRoles: Array.isArray(config.ignoredRoles) ? config.ignoredRoles : [],
  };
}

export async function getAntiScamConfig(client, guildId) {
  const config = await getGuildConfig(client, guildId).catch(() => null);
  return normalizeConfig(config?.antiScam);
}

export async function updateAntiScamConfig(client, guildId, patch) {
  await patchGuildConfig(client, guildId, { antiScam: patch });
  return getAntiScamConfig(client, guildId);
}

export function getStrikeCount(guildId, userId, windowHours = 24) {
  const windowMs = windowHours * 3600_000;
  const now = Date.now();
  const list = (strikeStore.get(strikeKey(guildId, userId)) || []).filter((t) => now - t <= windowMs);
  if (list.length) strikeStore.set(strikeKey(guildId, userId), list);
  else strikeStore.delete(strikeKey(guildId, userId));
  return list.length;
}

function recordStrike(guildId, userId, windowHours) {
  const windowMs = windowHours * 3600_000;
  const now = Date.now();
  const key = strikeKey(guildId, userId);
  const list = (strikeStore.get(key) || []).filter((t) => now - t <= windowMs);
  list.push(now);
  strikeStore.set(key, list);
  return list.length;
}

export function resetStrikes(guildId, userId) {
  strikeStore.delete(strikeKey(guildId, userId));
}

function isExemptMember(member, config) {
  if (!member) return false;
  // Staf (punya Manage Server / Administrator) dikecualikan agar tidak salah hapus.
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const ignoredRoles = config.ignoredRoles || [];
  if (ignoredRoles.length && member.roles?.cache) {
    if (ignoredRoles.some((roleId) => member.roles.cache.has(roleId))) return true;
  }
  return false;
}

async function fetchAttachmentBuffer(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function truncate(text, max = 120) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildScamEmbed({ type, count, findings, mode, user, channel, strikeCount, timedOut, timeoutMinutes }) {
  const meta = SCAM_TYPES[type] || SCAM_TYPES.file;
  const userMention = user ? `<@${user.id}>` : 'Seseorang';
  const embed = createEmbed({
    title: `${POLICE_EMOJI} ${meta.label}`,
    description: meta.description(count).replace(/\{user\}/g, userMention),
    color: 'error',
  });

  const reasonLines = findings
    .map((finding) => `• ${finding.reason}${finding.detail ? ` — \`${truncate(finding.detail)}\`` : ''}`)
    .join('\n')
    .slice(0, 1024);

  if (mode === 'log') {
    const fields = [
      { name: 'Pelanggar', value: user ? `<@${user.id}> (\`${user.id}\`)` : 'Tidak diketahui', inline: true },
      { name: 'Channel', value: channel ? `${channel}` : 'Tidak diketahui', inline: true },
      { name: 'Strike', value: `${strikeCount}`, inline: true },
      { name: 'Alasan deteksi', value: reasonLines || '-', inline: false },
    ];
    if (timedOut) {
      fields.push({ name: 'Aksi', value: `Timeout otomatis ${timeoutMinutes} menit (pelanggaran berulang)`, inline: false });
    }
    embed.addFields(fields);
    return embed;
  }

  if (reasonLines) {
    embed.addFields({ name: 'Alasan', value: reasonLines, inline: false });
  }
  if (timedOut) {
    embed.addFields({
      name: 'Konsekuensi',
      value: `Kamu di-timeout **${timeoutMinutes} menit** karena mengulangi pelanggaran scam.`,
      inline: false,
    });
  } else if (strikeCount > 1) {
    embed.addFields({
      name: 'Peringatan',
      value: `Ini pelanggaran ke-${strikeCount}. Pelanggaran berulang akan berujung timeout otomatis.`,
      inline: false,
    });
  }
  return embed;
}

async function sendChannelNotice(message, payload) {
  try {
    const sent = await message.channel.send({
      embeds: [buildScamEmbed({ ...payload, mode: 'notice' })],
      allowedMentions: { parse: [] },
    });
    setTimeout(() => sent.delete().catch(() => {}), 15000);
    return sent;
  } catch (error) {
    logger.debug('[ANTISCAM] Gagal kirim notice channel:', error?.message);
    return null;
  }
}

async function sendUserWarning(message, payload) {
  const embed = buildScamEmbed({ ...payload, mode: 'warn' });
  try {
    await message.author.send({ embeds: [embed] });
    return true;
  } catch {
    // DM ditutup → kirim sebagai balasan sementara di channel lalu hapus.
    try {
      const sent = await message.channel.send({
        content: `<@${message.author.id}>`,
        embeds: [embed],
        allowedMentions: { users: [message.author.id] },
      });
      setTimeout(() => sent.delete().catch(() => {}), 15000);
    } catch (error) {
      logger.debug('[ANTISCAM] Gagal kirim warning:', error?.message);
    }
    return false;
  }
}

async function sendLog(guild, config, payload) {
  if (!config.logChannelId) return null;
  let channel = guild.channels.cache.get(config.logChannelId);
  if (!channel) {
    channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  }
  if (!channel || !channel.isTextBased?.()) return null;
  try {
    return await channel.send({ embeds: [buildScamEmbed({ ...payload, mode: 'log' })], allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn('[ANTISCAM] Gagal kirim log:', error?.message);
    return null;
  }
}

/**
 * Pindai satu pesan dan jalankan aksi anti-scam bila diperlukan.
 * @returns {Promise<{detected: boolean, findings?: object[], action?: object}>}
 */
export async function handleAntiScam(message, client) {
  try {
    if (!message?.guild) return { detected: false };
    if (!message.author || message.author.bot || message.system) return { detected: false };
    const channel = message.channel;
    if (!channel || (typeof channel.isTextBased === 'function' && !channel.isTextBased())) {
      return { detected: false };
    }

    const config = await getAntiScamConfig(client, message.guild.id);
    if (!config.enabled) return { detected: false };
    if (config.ignoredChannels.includes(channel.id)) return { detected: false };
    if (isExemptMember(message.member, config)) return { detected: false };

    const findings = [];

    // --- Link phishing ---
    if (config.modules.link && message.content) {
      for (const { url } of extractUrls(message.content)) {
        const result = analyzeLink(url);
        if (result.suspicious) {
          findings.push({ type: 'link', reason: result.reason, detail: result.host, url: url.href });
        }
      }
    }

    // --- Attachment (foto / file) ---
    const attachments = [...(message.attachments?.values?.() || [])];
    for (const attachment of attachments) {
      if (isImageAttachment(attachment)) {
        if (!config.modules.photo) continue;
        if ((attachment.size || 0) > MAX_ATTACHMENT_BYTES) continue;
        try {
          const buffer = await fetchAttachmentBuffer(attachment);
          const result = await analyzeImageBuffer(buffer, {
            knownHashes: config.knownScamHashes,
            hashThreshold: HASH_THRESHOLD_DEFAULT,
          });
          if (result.suspicious) {
            findings.push({ type: 'photo', reason: result.reason, detail: attachment.name, hash: result.hash });
          }
        } catch (error) {
          logger.debug('[ANTISCAM] Gagal analisa gambar:', error?.message);
        }
      } else {
        if (!config.modules.file) continue;
        const result = analyzeAttachment(attachment);
        if (result.suspicious) {
          findings.push({ type: 'file', reason: result.reason, detail: result.fileName });
        }
      }
    }

    if (findings.length === 0) return { detected: false };

    return await applyActions({ message, config, findings });
  } catch (error) {
    logger.error('[ANTISCAM] handleAntiScam error:', error);
    return { detected: false };
  }
}

async function applyActions({ message, config, findings }) {
  const guild = message.guild;
  const author = message.author;
  const member = message.member;

  const primaryType = findings[0].type;
  const count = findings.filter((finding) => finding.type === primaryType).length;

  // 1. Hapus pesan scam
  let deleted = false;
  if (config.deleteMessage) {
    deleted = await message.delete().then(() => true).catch(() => false);
  }

  // 2. Catat strike & terapkan timeout otomatis untuk pelanggar berulang
  const strikeCount = recordStrike(guild.id, author.id, config.strikeWindowHours);
  let timedOut = false;
  let timeoutMinutes = 0;
  if (
    config.timeoutOnRepeat &&
    strikeCount >= config.timeoutThreshold &&
    member?.moderatable
  ) {
    const durationMs = config.timeoutDurationMinutes * 60_000;
    timedOut = await member
      .timeout(durationMs, `Anti-Scam: pelanggaran scam berulang (${strikeCount}x)`)
      .then(() => true)
      .catch(() => false);
    if (timedOut) {
      timeoutMinutes = config.timeoutDurationMinutes;
      resetStrikes(guild.id, author.id);
    }
  }

  const payload = {
    type: primaryType,
    count,
    findings,
    user: author,
    channel: message.channel,
    strikeCount,
    timedOut,
    timeoutMinutes,
  };

  // 3. Peringatan publik + peringatan pribadi ke pengirim
  if (config.notifyChannel && deleted) {
    await sendChannelNotice(message, payload);
  }
  if (config.warnUser) {
    await sendUserWarning(message, payload);
  }

  // 4. Log ke channel khusus
  await sendLog(guild, config, payload);

  return {
    detected: true,
    findings,
    action: { deleted, timedOut, strikeCount },
  };
}
