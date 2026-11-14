// voiceMilestoneLeaderboardCard.js
//
// Renders a PNG "podium" card for the voice milestone leaderboard. The top 3
// members are shown as a podium (1st center, 2nd left, 3rd right) with their
// avatar, display name, current tier, and total voice time. Reuses the same
// background + fonts as the single milestone card.

import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOUR_MS = 60 * 60 * 1000;
const CARD_WIDTH = 900;
const CARD_HEIGHT = 520;

const BACKGROUND_PATH = fileURLToPath(new URL('../assets/voice-milestone-background.jpg', import.meta.url));
const FONT_REGULAR_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
const FONT_BOLD_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));

const FONT_FAMILY = 'Manay Sans';
const FONT_BOLD_FAMILY = 'Manay Sans Bold';

const PODIUM_COLORS = {
  1: '#F6D365', // gold
  2: '#C9CDD4', // silver
  3: '#E0A878', // bronze
};

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

function fitText(context, text, x, y, maxWidth, fontSize, minFontSize = 14, bold = true, align = 'left') {
  let size = fontSize;
  context.font = fontString(size, bold);
  while (context.measureText(text).width > maxWidth && size > minFontSize) {
    size -= 1;
    context.font = fontString(size, bold);
  }
  if (align === 'center') {
    context.textAlign = 'center';
    context.fillText(text, x, y);
    context.textAlign = 'left';
  } else {
    context.fillText(text, x, y);
  }
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

/**
 * Draw a single podium column.
 * rank: 1 (tallest, center), 2 (medium, left), 3 (shortest, right)
 */
function drawPodiumColumn(context, column, entry) {
  const { x, width, topY, color } = column;
  const accent = toHexColor(entry.color) || color;

  // podium block
  roundedRect(context, x, topY, width, column.height, 16);
  const gradient = context.createLinearGradient(0, topY, 0, topY + column.height);
  gradient.addColorStop(0, accent);
  gradient.addColorStop(1, shadeColor(accent, -30));
  context.fillStyle = gradient;
  context.fill();

  // subtle inner top highlight
  roundedRect(context, x + 6, topY + 6, width - 12, 4, 2);
  context.fillStyle = 'rgba(255, 255, 255, 0.35)';
  context.fill();
}

function shadeColor(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt));
  const B = Math.max(0, Math.min(255, (num & 0x0000ff) + amt));
  return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
}

async function drawMember(context, entry, cx, baseY, rank, accent) {
  const avatarRadius = rank === 1 ? 56 : 44;
  const avatarY = baseY - avatarRadius - 18;

  // crown for #1
  if (rank === 1) {
    context.font = fontString(32);
    context.textAlign = 'center';
    context.fillText('👑', cx, avatarY - avatarRadius - 8);
    context.textAlign = 'left';
  }

  // rank badge
  const badgeRadius = 18;
  const badgeX = cx + avatarRadius - 10;
  const badgeY = avatarY - avatarRadius + 10;
  context.beginPath();
  context.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
  context.fillStyle = accent;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = '#0C1214';
  context.stroke();
  context.fillStyle = '#0C1214';
  context.font = fontString(18, true);
  context.textAlign = 'center';
  context.fillText(String(rank), badgeX, badgeY + 6);
  context.textAlign = 'left';

  // avatar ring
  context.beginPath();
  context.arc(cx, avatarY, avatarRadius + 5, 0, Math.PI * 2);
  context.fillStyle = 'rgba(8, 12, 14, 0.92)';
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = accent;
  context.stroke();

  const avatarImg = await getAvatar(entry.avatarURL);
  context.save();
  context.beginPath();
  context.arc(cx, avatarY, avatarRadius, 0, Math.PI * 2);
  context.clip();
  if (avatarImg) {
    context.drawImage(avatarImg, cx - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
  } else {
    context.fillStyle = '#33413D';
    context.fillRect(cx - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    context.fillStyle = '#F5F5F5';
    context.font = fontString(avatarRadius);
    context.textAlign = 'center';
    context.fillText(entry.displayName.slice(0, 1).toUpperCase(), cx, avatarY + avatarRadius * 0.35);
    context.textAlign = 'left';
  }
  context.restore();

  // name
  const nameY = baseY + 34;
  context.fillStyle = '#F5F6F6';
  fitText(context, entry.displayName, cx, nameY, 220, rank === 1 ? 22 : 18, 14, true, 'center');

  // tier label
  if (entry.tierLabel) {
    context.fillStyle = accent;
    fitText(context, entry.tierLabel.toUpperCase(), cx, nameY + 22, 200, 13, 11, true, 'center');
  }

  // total voice time
  context.fillStyle = '#0C1214';
  fitText(context, `⏱ ${formatDuration(entry.totalMs)}`, cx, baseY + (rank === 1 ? 92 : 78), 200, rank === 1 ? 20 : 17, 12, true, 'center');
}

export async function renderVoiceLeaderboardCard({ guildName = '', entries = [] }) {
  const top3 = entries.slice(0, 3);

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const context = canvas.getContext('2d');
  ensureFonts();

  const background = await getBackground();
  const scale = Math.max(CARD_WIDTH / background.width, CARD_HEIGHT / background.height);
  const bgW = background.width * scale;
  const bgH = background.height * scale;
  context.drawImage(background, (CARD_WIDTH - bgW) / 2, (CARD_HEIGHT - bgH) / 2, bgW, bgH);

  // dark overlay
  context.fillStyle = 'rgba(9, 14, 17, 0.72)';
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // card frame
  roundedRect(context, 16, 16, CARD_WIDTH - 32, CARD_HEIGHT - 32, 22);
  context.fillStyle = 'rgba(12, 18, 20, 0.5)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = 'rgba(214, 177, 94, 0.7)';
  context.stroke();

  // ---- Header ----
  context.fillStyle = '#F6D365';
  context.font = fontString(15);
  context.letterSpacing = '4px';
  context.fillText('MANAY SOCIETY  ·  VOICE LEADERBOARD', 32, 52);
  context.letterSpacing = '0px';

  context.fillStyle = '#F5F6F6';
  fitText(context, guildName.toUpperCase(), 32, 84, CARD_WIDTH - 64 - 150, 26, 16);

  // live pill
  const pillText = '● LIVE';
  context.font = fontString(14);
  const pillWidth = context.measureText(pillText).width + 28;
  const pillX = CARD_WIDTH - 32 - pillWidth;
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
  context.textAlign = 'left';

  // ---- Podium ----
  // Layout: rank 2 (left), rank 1 (center, tallest), rank 3 (right)
  const podiumBaseY = 380;
  const colWidth = 180;

  const first = top3[0];
  const second = top3[1];
  const third = top3[2];

  const accent1 = toHexColor(first?.color) || PODIUM_COLORS[1];
  const accent2 = toHexColor(second?.color) || PODIUM_COLORS[2];
  const accent3 = toHexColor(third?.color) || PODIUM_COLORS[3];

  // Center column (#1) — tallest
  const col1X = CARD_WIDTH / 2 - colWidth / 2;
  const col1Height = 130;
  if (first) {
    drawPodiumColumn(context, { x: col1X, width: colWidth, topY: podiumBaseY - col1Height, height: col1Height, color: accent1 }, first);
  }

  // Left column (#2)
  const col2X = col1X - colWidth - 40;
  const col2Height = 95;
  if (second) {
    drawPodiumColumn(context, { x: col2X, width: colWidth, topY: podiumBaseY - col2Height, height: col2Height, color: accent2 }, second);
  }

  // Right column (#3)
  const col3X = col1X + colWidth + 40;
  const col3Height = 70;
  if (third) {
    drawPodiumColumn(context, { x: col3X, width: colWidth, topY: podiumBaseY - col3Height, height: col3Height, color: accent3 }, third);
  }

  // Draw members (avatar + name + time) on top of podium
  if (first) {
    await drawMember(context, first, col1X + colWidth / 2, podiumBaseY - col1Height, 1, accent1);
  }
  if (second) {
    await drawMember(context, second, col2X + colWidth / 2, podiumBaseY - col2Height, 2, accent2);
  }
  if (third) {
    await drawMember(context, third, col3X + colWidth / 2, podiumBaseY - col3Height, 3, accent3);
  }

  // Empty state
  if (top3.length === 0) {
    context.fillStyle = '#AAB3B6';
    context.font = fontString(16, false);
    context.textAlign = 'center';
    context.fillText('Belum ada data voice time. Ayo mulai ngobrol di voice!', CARD_WIDTH / 2, CARD_HEIGHT / 2);
    context.textAlign = 'left';
  }

  return canvas.toBuffer('image/png');
}
