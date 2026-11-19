import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getAntiScamConfig, POLICE_EMOJI } from '../../../services/antiScamService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { logger } from '../../../utils/logger.js';

const DASHBOARD_TITLE = `${POLICE_EMOJI} Anti-Scam Protection`;

function stateLabel(value) {
  return value ? 'On' : 'Off';
}

function toggleButton(customId, label, enabled) {
  return new ButtonBuilder()
    .setCustomId(`antiscam_toggle:${customId}`)
    .setLabel(label)
    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Danger);
}

export function createAntiScamComponents(config) {
  const rows = [];

  rows.push(
    new ActionRowBuilder().addComponents(
      toggleButton('enabled', 'Protection', config.enabled),
      toggleButton('photo', 'Photo Scam', config.modules.photo),
      toggleButton('file', 'Suspicious File', config.modules.file),
      toggleButton('link', 'Discord Phishing', config.modules.link),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      toggleButton('deleteMessage', 'Auto-Delete', config.deleteMessage),
      toggleButton('warnUser', 'DM Warning', config.warnUser),
      toggleButton('notifyChannel', 'Channel Notice', config.notifyChannel),
      toggleButton('timeoutOnRepeat', 'Auto-Timeout', config.timeoutOnRepeat),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('antiscam_channel')
        .setPlaceholder('Set or clear the anti-scam log channel…')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Set Log Channel').setValue('set'),
          new StringSelectMenuOptionBuilder().setLabel('Clear Log Channel').setValue('clear'),
        ),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('antiscam_timeout')
        .setLabel('Configure Timeout')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('antiscam_refresh')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return rows;
}

async function formatChannelMention(guild, id) {
  if (!id) return '`Belum diatur`';
  const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  return channel ? channel.toString() : `Missing (\`${id}\`)`;
}

export async function buildAntiScamDashboardView(interaction, client) {
  const config = await getAntiScamConfig(client, interaction.guildId);
  const logChannel = await formatChannelMention(interaction.guild, config.logChannelId);

  const embed = createEmbed({
    title: DASHBOARD_TITLE,
    description: `Lindungi **${interaction.guild.name}** dari scam otomatis — foto scam, file mencurigakan, dan link phishing Discord. Pesan scam dihapus, pengirim diperingatkan, dan kejadian dicatat ke channel log.`,
    color: config.enabled ? 'success' : 'warning',
    fields: [
      { name: 'Status', value: config.enabled ? 'Aktif' : 'Nonaktif', inline: true },
      {
        name: 'Deteksi',
        value: [
          `Photo Scam: ${stateLabel(config.modules.photo)}`,
          `Suspicious File: ${stateLabel(config.modules.file)}`,
          `Discord Phishing: ${stateLabel(config.modules.link)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Aksi',
        value: [
          `Hapus pesan: ${stateLabel(config.deleteMessage)}`,
          `Warning pengirim: ${stateLabel(config.warnUser)}`,
          `Notice channel: ${stateLabel(config.notifyChannel)}`,
          `Timeout otomatis: ${stateLabel(config.timeoutOnRepeat)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Timeout Berulang',
        value: `${config.timeoutThreshold}x dalam ${config.strikeWindowHours} jam → timeout ${config.timeoutDurationMinutes} menit`,
        inline: false,
      },
      { name: 'Log Channel', value: logChannel, inline: true },
      { name: 'Signature Foto Scam', value: `${config.knownScamHashes.length} signature`, inline: true },
    ],
  });

  return { embed, components: createAntiScamComponents(config) };
}

export async function refreshAntiScamDashboard(interaction, client) {
  const { embed, components } = await buildAntiScamDashboardView(interaction, client);
  await interaction.message.edit({ embeds: [embed], components, content: null }).catch(() => {});
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    try {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return await replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: 'Kamu butuh izin **Manage Server** untuk membuka dashboard anti-scam.',
        });
      }

      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const { embed, components } = await buildAntiScamDashboardView(interaction, client);
      await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });
    } catch (error) {
      logger.error('antiscam_dashboard error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Gagal memuat dashboard anti-scam.' });
    }
  },
};
