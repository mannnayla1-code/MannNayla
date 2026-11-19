import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { replyUserError, ErrorTypes, handleInteractionError } from '../utils/errorHandler.js';
import { getAntiScamConfig, updateAntiScamConfig } from '../services/antiScamService.js';
import { buildAntiScamDashboardView, refreshAntiScamDashboard } from '../commands/Moderation/modules/antiscam_dashboard.js';

const TOGGLEABLE = new Set([
  'enabled',
  'photo',
  'file',
  'link',
  'deleteMessage',
  'warnUser',
  'notifyChannel',
  'timeoutOnRepeat',
]);

function deny(interaction) {
  return interaction.reply({
    content: 'Kamu butuh izin **Manage Server** untuk memakai ini.',
    flags: MessageFlags.Ephemeral,
  });
}

async function updateDashboard(interaction, client) {
  const { embed, components } = await buildAntiScamDashboardView(interaction, client);
  return interaction.update({ embeds: [embed], components, content: null });
}

async function handleToggle(interaction, client, args) {
  const key = args[0];
  if (!TOGGLEABLE.has(key)) {
    return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Tombol tidak valid.' });
  }

  const config = await getAntiScamConfig(client, interaction.guildId);

  if (key === 'enabled') {
    await updateAntiScamConfig(client, interaction.guildId, { enabled: !config.enabled });
  } else if (['photo', 'file', 'link'].includes(key)) {
    await updateAntiScamConfig(client, interaction.guildId, { modules: { ...config.modules, [key]: !config.modules[key] } });
  } else {
    await updateAntiScamConfig(client, interaction.guildId, { [key]: !config[key] });
  }

  return updateDashboard(interaction, client);
}

async function showChannelModal(interaction, client) {
  const modalCustomId = 'antiscam_modal:channel';

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('antiscam_log_channel')
    .setPlaceholder('Pilih channel teks…')
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setRequired(true);

  const channelLabel = new LabelBuilder()
    .setLabel('Channel Log Anti-Scam')
    .setDescription('Semua kejadian scam akan dicatat ke channel ini')
    .setChannelSelectMenuComponent(channelSelect);

  const modal = new ModalBuilder()
    .setCustomId(modalCustomId)
    .setTitle('Set Log Channel')
    .addLabelComponents(channelLabel);

  await interaction.showModal(modal);

  try {
    const submission = await interaction.awaitModalSubmit({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalCustomId,
    });

    const channelId = submission.fields.getField('antiscam_log_channel').values[0];
    const channel = interaction.guild.channels.cache.get(channelId)
      ?? (await interaction.guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
      return submission.reply({ content: 'Channel tidak ditemukan.', flags: MessageFlags.Ephemeral });
    }

    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return submission.reply({
        content: 'Aku butuh izin **View Channel**, **Send Messages**, dan **Embed Links** di channel itu.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await updateAntiScamConfig(client, interaction.guildId, { logChannelId: channel.id });
    await submission.reply({
      embeds: [successEmbed('Anti-Scam Updated', `Kejadian scam akan dicatat ke ${channel}.`)],
      flags: MessageFlags.Ephemeral,
    });

    await refreshAntiScamDashboard(interaction, client);
  } catch (error) {
    if (error.code === 'INTERACTION_TIMEOUT') return;
    await handleInteractionError(interaction, error, { type: 'modal', customId: modalCustomId, handler: 'antiscam_channel' });
  }
}

function numericInput(customId, label, value, description) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(value))
    .setMaxLength(5);
  if (description) input.setPlaceholder(description);
  return new ActionRowBuilder().addComponents(input);
}

async function showTimeoutModal(interaction, client) {
  const modalCustomId = 'antiscam_modal:timeout';
  const config = await getAntiScamConfig(client, interaction.guildId);

  const modal = new ModalBuilder()
    .setCustomId(modalCustomId)
    .setTitle('Configure Auto-Timeout')
    .addComponents(
      numericInput('antiscam_threshold', 'Strikes sebelum timeout', config.timeoutThreshold, '1-20'),
      numericInput('antiscam_duration', 'Durasi timeout (menit)', config.timeoutDurationMinutes, '1-10080'),
      numericInput('antiscam_window', 'Jendela strike (jam)', config.strikeWindowHours, '1-168'),
    );

  await interaction.showModal(modal);

  try {
    const submission = await interaction.awaitModalSubmit({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalCustomId,
    });

    const threshold = Number.parseInt(submission.fields.getTextInputValue('antiscam_threshold'), 10);
    const duration = Number.parseInt(submission.fields.getTextInputValue('antiscam_duration'), 10);
    const window = Number.parseInt(submission.fields.getTextInputValue('antiscam_window'), 10);

    if (![threshold, duration, window].every((n) => Number.isInteger(n) && n > 0)) {
      return submission.reply({ content: 'Semua nilai harus berupa angka positif.', flags: MessageFlags.Ephemeral });
    }
    if (threshold > 20 || duration > 10080 || window > 168) {
      return submission.reply({ content: 'Nilai di luar batas (strike 1-20, durasi 1-10080 menit, jendela 1-168 jam).', flags: MessageFlags.Ephemeral });
    }

    await updateAntiScamConfig(client, interaction.guildId, {
      timeoutThreshold: threshold,
      timeoutDurationMinutes: duration,
      strikeWindowHours: window,
    });

    await submission.reply({
      embeds: [
        successEmbed(
          'Anti-Scam Updated',
          `Timeout otomatis: ${threshold}x pelanggaran / ${window} jam → timeout ${duration} menit.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });

    await refreshAntiScamDashboard(interaction, client);
  } catch (error) {
    if (error.code === 'INTERACTION_TIMEOUT') return;
    await handleInteractionError(interaction, error, { type: 'modal', customId: modalCustomId, handler: 'antiscam_timeout' });
  }
}

export default {
  customIds: ['antiscam_toggle', 'antiscam_refresh', 'antiscam_timeout'],

  async execute(interaction, client, args = []) {
    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return deny(interaction);
      }

      const [customId] = interaction.customId.split(':');

      if (customId === 'antiscam_refresh') {
        return updateDashboard(interaction, client);
      }
      if (customId === 'antiscam_toggle') {
        return handleToggle(interaction, client, args);
      }
      if (customId === 'antiscam_timeout') {
        return showTimeoutModal(interaction, client);
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'button',
        customId: interaction.customId,
        handler: 'antiscam',
      });
    }
  },
};

export async function handleAntiScamMenuSelect(interaction, client) {
  try {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return deny(interaction);
    }

    const value = interaction.values[0];

    if (value === 'clear') {
      await updateAntiScamConfig(client, interaction.guildId, { logChannelId: null });
      return updateDashboard(interaction, client);
    }

    if (value === 'set') {
      return showChannelModal(interaction, client);
    }

    return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Opsi tidak valid.' });
  } catch (error) {
    await handleInteractionError(interaction, error, {
      type: 'select_menu',
      customId: interaction.customId,
      handler: 'antiscam',
    });
  }
}
