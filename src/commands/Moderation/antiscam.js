import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
  getAntiScamConfig,
  updateAntiScamConfig,
  getStrikeCount,
  POLICE_EMOJI,
} from '../../services/antiScamService.js';
import { computeDHash, isImageAttachment } from '../../utils/antiScam.js';
import dashboard from './modules/antiscam_dashboard.js';

const MAX_SIGNATURES = 500;
const MODULE_LABELS = {
  photo: 'Photo Scam',
  file: 'Suspicious File',
  link: 'Discord Phishing',
};

function parseMessageLink(link) {
  const match = String(link || '').match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

function buildStatusEmbed(config, guildName) {
  const on = (value) => (value ? 'Aktif' : 'Nonaktif');
  return createEmbed({
    title: `${POLICE_EMOJI} Anti-Scam Protection`,
    description: `Status konfigurasi anti-scam untuk **${guildName}**.`,
    color: config.enabled ? 'success' : 'warning',
    fields: [
      { name: 'Status', value: on(config.enabled), inline: true },
      { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Belum diatur', inline: true },
      {
        name: 'Deteksi',
        value: [
          `Photo Scam: ${on(config.modules.photo)}`,
          `Suspicious File: ${on(config.modules.file)}`,
          `Discord Phishing: ${on(config.modules.link)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Aksi',
        value: [
          `Hapus pesan: ${on(config.deleteMessage)}`,
          `Warning pengirim: ${on(config.warnUser)}`,
          `Notice channel: ${on(config.notifyChannel)}`,
          `Timeout otomatis: ${on(config.timeoutOnRepeat)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Timeout Berulang',
        value: `${config.timeoutThreshold}x pelanggaran dalam ${config.strikeWindowHours} jam → timeout ${config.timeoutDurationMinutes} menit`,
        inline: false,
      },
      { name: 'Signature Foto Scam', value: `${config.knownScamHashes.length} hash tersimpan`, inline: false },
    ],
  });
}

async function handleToggle(interaction, client, config) {
  const module = interaction.options.getString('module');
  const enabled = interaction.options.getBoolean('enabled');

  const nextModules = { ...config.modules };
  if (module === 'enabled') {
    await updateAntiScamConfig(client, interaction.guildId, { enabled });
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Anti-Scam Updated', `Anti-Scam Protection sekarang **${enabled ? 'aktif' : 'nonaktif'}**.`)],
    });
  }

  if (!MODULE_LABELS[module]) {
    return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Modul tidak dikenali.' });
  }

  nextModules[module] = enabled;
  await updateAntiScamConfig(client, interaction.guildId, { modules: nextModules });
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Anti-Scam Updated', `Deteksi **${MODULE_LABELS[module]}** sekarang **${enabled ? 'aktif' : 'nonaktif'}**.`)],
  });
}

async function handleChannel(interaction, client, config) {
  const channel = interaction.options.getChannel('channel');
  const disable = interaction.options.getBoolean('disable') || false;

  if (disable) {
    await updateAntiScamConfig(client, interaction.guildId, { logChannelId: null });
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Anti-Scam Updated', 'Log channel anti-scam sudah dikosongkan.')],
    });
  }

  if (!channel) {
    return replyUserError(interaction, {
      type: ErrorTypes.VALIDATION,
      message: 'Pilih sebuah channel, atau gunakan `disable: True` untuk mengosongkan.',
    });
  }

  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: 'Aku butuh izin **View Channel**, **Send Messages**, dan **Embed Links** di channel itu.',
    });
  }

  await updateAntiScamConfig(client, interaction.guildId, { logChannelId: channel.id });
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Anti-Scam Updated', `Kejadian scam akan dicatat ke ${channel}.`)],
  });
}

async function handleTimeout(interaction, client) {
  const threshold = interaction.options.getInteger('threshold');
  const duration = interaction.options.getInteger('duration');
  const window = interaction.options.getInteger('window');
  const enabled = interaction.options.getBoolean('enabled');

  const patch = {};
  if (threshold !== null && threshold !== undefined) patch.timeoutThreshold = threshold;
  if (duration !== null && duration !== undefined) patch.timeoutDurationMinutes = duration;
  if (window !== null && window !== undefined) patch.strikeWindowHours = window;
  if (enabled !== null && enabled !== undefined) patch.timeoutOnRepeat = enabled;

  if (Object.keys(patch).length === 0) {
    return replyUserError(interaction, {
      type: ErrorTypes.VALIDATION,
      message: 'Isi minimal satu opsi (threshold, duration, window, atau enabled).',
    });
  }

  const updated = await updateAntiScamConfig(client, interaction.guildId, patch);
  return InteractionHelper.safeEditReply(interaction, {
    embeds: [
      successEmbed(
        'Anti-Scam Updated',
        [
          `Timeout otomatis: ${updated.timeoutOnRepeat ? 'aktif' : 'nonaktif'}`,
          `Ambang: ${updated.timeoutThreshold}x pelanggaran / ${updated.strikeWindowHours} jam`,
          `Durasi timeout: ${updated.timeoutDurationMinutes} menit`,
        ].join('\n'),
      ),
    ],
  });
}

async function handleSignature(interaction, client, config) {
  const action = interaction.options.getString('action');

  if (action === 'list') {
    const lines = config.knownScamHashes.length
      ? config.knownScamHashes.map((hash) => `\`${hash}\``).join('\n')
      : 'Belum ada signature.';
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('Signature Foto Scam', `${config.knownScamHashes.length} signature terdaftar.\n\n${lines}`.slice(0, 4000))],
    });
  }

  if (action === 'clear') {
    await updateAntiScamConfig(client, interaction.guildId, { knownScamHashes: [] });
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Signature Dihapus', 'Semua signature foto scam sudah dikosongkan.')],
    });
  }

  if (action === 'remove') {
    const hash = (interaction.options.getString('hash') || '').trim().toLowerCase();
    if (!hash) {
      return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Berikan `hash` yang ingin dihapus.' });
    }
    const next = config.knownScamHashes.filter((entry) => entry.toLowerCase() !== hash);
    if (next.length === config.knownScamHashes.length) {
      return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Signature itu tidak ditemukan.' });
    }
    await updateAntiScamConfig(client, interaction.guildId, { knownScamHashes: next });
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Signature Dihapus', `Signature \`${hash}\` sudah dihapus.`)],
    });
  }

  if (action === 'add') {
    let hash = (interaction.options.getString('hash') || '').trim().toLowerCase();
    const link = interaction.options.getString('link');

    if (!hash && link) {
      const parsed = parseMessageLink(link);
      if (!parsed || parsed.guildId !== interaction.guildId) {
        return replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Link pesan tidak valid atau bukan dari server ini.',
        });
      }
      const channel = await interaction.guild.channels.fetch(parsed.channelId).catch(() => null);
      const message = await channel?.messages.fetch(parsed.messageId).catch(() => null);
      const attachment = message?.attachments?.find((item) => isImageAttachment(item));
      if (!attachment) {
        return replyUserError(interaction, {
          type: ErrorTypes.USER_INPUT,
          message: 'Pesan itu tidak punya lampiran gambar.',
        });
      }
      try {
        const buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer());
        hash = await computeDHash(buffer);
      } catch (error) {
        logger.warn('[ANTISCAM] Gagal menghitung hash gambar:', error?.message);
        return replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Gagal memproses gambar tersebut.',
        });
      }
    }

    if (!hash || !/^[0-9a-f]{16}$/.test(hash)) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Berikan sebuah `hash` (16 karakter hex) atau `link` pesan berisi gambar scam.',
      });
    }

    if (config.knownScamHashes.some((entry) => entry.toLowerCase() === hash)) {
      return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Signature itu sudah terdaftar.' });
    }

    const next = [...config.knownScamHashes, hash].slice(-MAX_SIGNATURES);
    await updateAntiScamConfig(client, interaction.guildId, { knownScamHashes: next });
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Signature Ditambahkan', `Signature \`${hash}\` sekarang aktif.\nTotal: ${next.length} signature.`)],
    });
  }

  return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Aksi tidak dikenali.' });
}

export default {
  data: new SlashCommandBuilder()
    .setName('antiscam')
    .setDescription('Anti-Scam Protection — deteksi otomatis & hapus pesan scam.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dashboard')
        .setDescription('Buka dashboard interaktif untuk mengatur anti-scam.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('toggle')
        .setDescription('Nyalakan/matikan perlindungan atau salah satu jenis deteksi.')
        .addStringOption((option) =>
          option
            .setName('module')
            .setDescription('Yang ingin diubah.')
            .setRequired(true)
            .addChoices(
              { name: 'Perlindungan (master)', value: 'enabled' },
              { name: 'Photo Scam', value: 'photo' },
              { name: 'Suspicious File', value: 'file' },
              { name: 'Discord Phishing', value: 'link' },
            ),
        )
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('True = aktif, False = nonaktif.').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('channel')
        .setDescription('Atur channel log khusus anti-scam.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel teks untuk mencatat kejadian scam.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('disable').setDescription('True untuk mengosongkan log channel.').setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('timeout')
        .setDescription('Atur timeout otomatis untuk pelanggar berulang.')
        .addIntegerOption((option) =>
          option.setName('threshold').setDescription('Jumlah pelanggaran sebelum timeout (1-20).').setMinValue(1).setMaxValue(20).setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('duration').setDescription('Durasi timeout dalam menit (1-10080).').setMinValue(1).setMaxValue(10080).setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('window').setDescription('Jendela waktu hitung strike dalam jam (1-168).').setMinValue(1).setMaxValue(168).setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Aktifkan/nonaktifkan timeout otomatis.').setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('signature')
        .setDescription('Kelola signature gambar scam (perceptual hash) untuk deteksi Photo Scam.')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('Aksi untuk signature.')
            .setRequired(true)
            .addChoices(
              { name: 'add', value: 'add' },
              { name: 'list', value: 'list' },
              { name: 'remove', value: 'remove' },
              { name: 'clear', value: 'clear' },
            ),
        )
        .addStringOption((option) =>
          option.setName('hash').setDescription('Hash 16 karakter hex (untuk add/remove).').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('link').setDescription('Link pesan berisi gambar scam (untuk add).').setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Lihat konfigurasi anti-scam saat ini.'),
    ),

  async execute(interaction, config, client) {
    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return await replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: 'Kamu butuh izin **Manage Server** untuk mengatur anti-scam.',
        });
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'dashboard') {
        return await dashboard.execute(interaction, config, client);
      }

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;

      const antiScamConfig = await getAntiScamConfig(client, interaction.guildId);

      if (subcommand === 'toggle') return await handleToggle(interaction, client, antiScamConfig);
      if (subcommand === 'channel') return await handleChannel(interaction, client, antiScamConfig);
      if (subcommand === 'timeout') return await handleTimeout(interaction, client);
      if (subcommand === 'signature') return await handleSignature(interaction, client, antiScamConfig);
      if (subcommand === 'status') {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [buildStatusEmbed(antiScamConfig, interaction.guild.name)],
        });
      }

      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Subcommand tidak dikenali.' });
    } catch (error) {
      logger.error('antiscam command error:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: 'Terjadi kesalahan saat mengatur anti-scam.',
      }).catch(() => {});
    }
  },
};
