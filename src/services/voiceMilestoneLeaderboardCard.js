// voiceMilestoneLeaderboardCard.js
//
// Renders a PNG "podium" card for the voice milestone leaderboard. Top members
// are listed with their avatar, display name, current tier, and total voice
// time. Reuses the same background + fonts as the single milestone card.

import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOUR_MS = 60 * 60 * 1000;
const CARD_WIDTH = 900;
const ROW_HEIGHT = 64;
const HEADER_HEIGHT = 96;
const PADDING = 28;
const MAX_ROWS = 10;

const BACKGROUND_PATH = fileURLToPath(new URL('../assets/voice-milestone-background.jpg', import.meta.url));
const FONT_REGULAR_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
const FONT_BOLD_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));

const FONT_FAMILY = 'Manay Sans';
const FONT_BOLD_FAMILY = 'Manay Sans Bold';

const RANK_COLORS = ['#F6D365', '#C9CDD4', '#E0A878']; // gold, silver, bronze
const DEFAULT_RANK_COLOR = '#8A9397';

let backgroundPromise;
let fontsRegistered = false;

function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(FONT_REGULAR_PATH, FONT_FAMILY);
  GlobalFonts.registerFromPath(FONT_BOLD_PATH, FONT_BOLD_FAMILY);
  fontsRegistered = true;
}

function fontString(size, bold = true) {
  return `${size}px "${bold ? FONT_BOLD_FAMILY : FONT_FAMILY}"`;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function fitText(context, text, x, y, maxWidth, fontSize, minFontSize = 14, bold = true) {
  let size = fontSize;
  context.font = fontString(size, bold);
  while (context.measureText(text).width > maxWidth && size > minFontSize) {
    size -= 1;
    context.font = fontString(size, bold);
  }
  context.fillText(text, x, y);
}

function toHexColor(color) {
  if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) return color;
  if (Number.isFinite(Number(color)) && Number(color) > 0) {
    return `#${Number(color).toString(16).padStart(6, '0').slice(-6)}`;
  }
  return null;
}

async function getBackground() {
  backgroundPromise ??= readFile(BACKGROUND_PATH).then(loadImage);
  return backgroundPromise;
}

async function getAvatar(url) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}j ${minutes}m`;
  if (hours) return `${hours}j`;
  return `${minutes}m`;
}

function rankMedal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export async function renderVoiceLeaderboardCard({ guildName = '', entries = [] }) {
  const rows = entries.slice(0, MAX_ROWS);
  const cardHeight = HEADER_HEIGHT + PADDING * 2 + rows.length * ROW_HEIGHT + (rows.length > 0 ? 0 : 40);

  const canvas = createCanvas(CARD_WIDTH, cardHeight);
  const context = canvas.getContext('2d');
  ensureFonts();

  const background = await getBackground();
  const scale = Math.max(CARD_WIDTH / background.width, cardHeight / background.height);
  const bgW = background.width * scale;
  const bgH = background.height * scale;
  context.drawImage(background, (CARD_WIDTH - bgW) / 2, (cardHeight - bgH) / 2, bgW, bgH);

  // dark overlay
  context.fillStyle = 'rgba(9, 14, 17, 0.72)';
  context.fillRect(0, 0, CARD_WIDTH, cardHeight);

  // card frame
  roundedRect(context, 16, 16, CARD_WIDTH - 32, cardHeight - 32, 22);
  context.fillStyle = 'rgba(12, 18, 20, 0.5)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = 'rgba(214, 177, 94, 0.7)';
  context.stroke();

  // ---- Header ----
  context.fillStyle = '#F6D365';
  context.font = fontString(15);
  context.letterSpacing = '4px';
  context.fillText('MANAY SOCIETY  ·  VOICE LEADERBOARD', PADDING, 50);
  context.letterSpacing = '0px';

  context.fillStyle = '#F5F6F6';
  fitText(context, guildName.toUpperCase(), PADDING, 86, CARD_WIDTH - PADDING * 2 - 160, 30, 18);

  // live pill
  const pillText = '● LIVE';
  context.font = fontString(14);
  const pillWidth = context.measureText(pillText).width + 28;
  const pillX = CARD_WIDTH - PADDING - pillWidth;
  const pillY = 54;
  roundedRect(context, pillX, pillY, pillWidth, 26, 13);
  context.fillStyle = 'rgba(34, 197, 94, 0.18)';
  context.fill();
  context.strokeStyle = 'rgba(34, 197, 94, 0.6)';
  context.lineWidth = 1.5;
  context.stroke();
  context.fillStyle = '#4ADE80';
  context.textAlign = 'center';
  context.fillText(pillText, pillX + pillWidth / 2, pillY + 18);
  context.textAlign = 'start';

  // ---- Rows ----
  const rowStartY = HEADER_HEIGHT + PADDING;
  const avatarRadius = 22;
  const avatarX = PADDING + 40;

  for (let i = 0; i < rows.length; i += 1) {
    const entry = rows[i];
    const rank = i + 1;
    const y = rowStartY + i * ROW_HEIGHT;
    const accent = toHexColor(entry.color) || RANK_COLORS[i] || DEFAULT_RANK_COLOR;

    // row background (subtle)
    roundedRect(context, PADDING, y, CARD_WIDTH - PADDING * 2, ROW_HEIGHT - 10, 14);
    context.fillStyle = 'rgba(255, 255, 255, 0.035)';
    context.fill();

    // rank
    context.fillStyle = accent;
    context.font = fontString(20, rank <= 3);
    context.textAlign = 'center';
    context.fillText(String(rankMedal(rank)), PADDING + 22, y + 33);
    context.textAlign = 'start';

    // avatar ring + avatar
    const avatarY = y + (ROW_HEIGHT - 10) / 2;
    context.beginPath();
    context.arc(avatarX, avatarY, avatarRadius + 3, 0, Math.PI * 2);
    context.fillStyle = 'rgba(8, 12, 14, 0.9)';
    context.fill();
    context.lineWidth = 2.5;
    context.strokeStyle = accent;
    context.stroke();

    const avatarImg = await getAvatar(entry.avatarURL);

    context.save();
    context.beginPath();
    context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    context.clip();
    if (avatarImg) {
      context.drawImage(avatarImg, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    } else {
      context.fillStyle = '#33413D';
      context.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
      context.fillStyle = '#F5F5F5';
      context.font = fontString(18);
      context.textAlign = 'center';
      context.fillText(entry.displayName.slice(0, 1).toUpperCase(), avatarX, avatarY + 6);
      context.textAlign = 'start';
    }
    context.restore();

    // name
    context.fillStyle = '#F5F6F6';
    fitText(context, entry.displayName, avatarX + avatarRadius + 16, y + 28, 320, 20, 14);

    // tier label
    if (entry.tierLabel) {
      context.fillStyle = accent;
      context.font = fontString(13);
      fitText(context, entry.tierLabel.toUpperCase(), avatarX + avatarRadius + 16, y + 46, 320, 13, 11);
    }

    // total voice time (right aligned)
    context.fillStyle = '#D8DEDF';
    context.font = fontString(18);
    context.textAlign = 'right';
    context.fillText(`⏱  ${formatDuration(entry.totalMs)}`, CARD_WIDTH - PADDING - 12, y + 33);
    context.textAlign = 'start';
  }

  if (rows.length === 0) {
    context.fillStyle = '#AAB3B6';
    context.font = fontString(16, false);
    context.textAlign = 'center';
    context.fillText('Belum ada data voice time. Ayo mulai ngobrol di voice!', CARD_WIDTH / 2, HEADER_HEIGHT + 50);
    context.textAlign = 'start';
  }

  return canvas.toBuffer('image/png');
}
