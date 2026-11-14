import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 420;
const HOUR_MS = 60 * 60 * 1000;
const BACKGROUND_PATH = fileURLToPath(new URL('../assets/voice-milestone-background.jpg', import.meta.url));
const FONT_REGULAR_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
const FONT_BOLD_PATH = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));

const FONT_FAMILY = 'Manay Sans';
const FONT_BOLD_FAMILY = 'Manay Sans Bold';

let backgroundPromise;
let fontsRegistered = false;

function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(FONT_REGULAR_PATH, FONT_FAMILY);
  GlobalFonts.registerFromPath(FONT_BOLD_PATH, FONT_BOLD_FAMILY);
  fontsRegistered = true;
}

function fontString(size, bold = true) {
  return `${bold ? '' : ''}${size}px "${bold ? FONT_BOLD_FAMILY : FONT_FAMILY}"`;
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function fitText(context, text, x, y, maxWidth, fontSize, minFontSize = 20) {
  let size = fontSize;
  context.font = fontString(size);

  while (context.measureText(text).width > maxWidth && size > minFontSize) {
    size -= 2;
    context.font = fontString(size);
  }

  context.fillText(text, x, y);
}

function toHexColor(color) {
  if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) return color;
  if (Number.isFinite(Number(color)) && Number(color) > 0) {
    return `#${Number(color).toString(16).padStart(6, '0').slice(-6)}`;
  }
  return '#D6B15E';
}

function drawShield(context, x, y, size, color) {
  const points = [
    [x + size * 0.12, y],
    [x + size * 0.88, y],
    [x + size * 0.84, y + size * 0.55],
    [x + size * 0.5, y + size],
    [x + size * 0.16, y + size * 0.55],
  ];

  context.beginPath();
  context.moveTo(...points[0]);
  for (const point of points.slice(1)) context.lineTo(...point);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 9;
  context.strokeStyle = 'rgba(12, 17, 19, 0.9)';
  context.stroke();

  context.beginPath();
  context.moveTo(x + size * 0.25, y + size * 0.13);
  context.lineTo(x + size * 0.75, y + size * 0.13);
  context.lineTo(x + size * 0.72, y + size * 0.52);
  context.lineTo(x + size * 0.5, y + size * 0.81);
  context.lineTo(x + size * 0.28, y + size * 0.52);
  context.closePath();
  context.lineWidth = 3;
  context.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  context.stroke();
}

async function getBackground() {
  backgroundPromise ??= readFile(BACKGROUND_PATH).then(loadImage);
  return backgroundPromise;
}

async function getAvatar(member) {
  const avatarUrl = member?.user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  if (!avatarUrl) return null;

  try {
    const response = await fetch(avatarUrl);
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function formatHours(ms) {
  const hours = Math.floor(Math.max(0, ms) / HOUR_MS);
  const minutes = Math.floor((Math.max(0, ms) % HOUR_MS) / 60000);
  if (hours && minutes) return `${hours}h ${minutes}m`;
  return hours ? `${hours}h` : `${minutes}m`;
}

export async function renderVoiceMilestoneCard({
  member,
  milestone,
  next,
  totalMs,
  roleColor,
  isTest = false,
  rank = null,
}) {
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const context = canvas.getContext('2d');
  ensureFonts();
  const background = await getBackground();
  const scale = Math.max(CARD_WIDTH / background.width, CARD_HEIGHT / background.height);
  const backgroundWidth = background.width * scale;
  const backgroundHeight = background.height * scale;
  context.drawImage(
    background,
    (CARD_WIDTH - backgroundWidth) / 2,
    (CARD_HEIGHT - backgroundHeight) / 2,
    backgroundWidth,
    backgroundHeight,
  );

  context.fillStyle = 'rgba(9, 14, 17, 0.58)';
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  roundedRect(context, 28, 24, CARD_WIDTH - 56, CARD_HEIGHT - 48, 28);
  context.fillStyle = 'rgba(12, 18, 20, 0.45)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = `${toHexColor(roleColor)}B8`;
  context.stroke();

  const accent = toHexColor(roleColor);
  const displayName = member?.displayName
    || member?.user?.globalName
    || member?.user?.username
    || 'Manay Member';
  const avatar = await getAvatar(member);

  // ---- Avatar (left) ----
  const avatarX = 170;
  const avatarY = 210;
  const avatarRadius = 82;
  context.beginPath();
  context.arc(avatarX, avatarY, avatarRadius + 8, 0, Math.PI * 2);
  context.fillStyle = 'rgba(8, 12, 14, 0.92)';
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = accent;
  context.stroke();

  context.save();
  context.beginPath();
  context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
  context.clip();
  if (avatar) {
    context.drawImage(avatar, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
  } else {
    context.fillStyle = '#33413D';
    context.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    context.fillStyle = '#F5F5F5';
    context.font = fontString(58);
    context.textAlign = 'center';
    context.fillText(displayName.slice(0, 1).toUpperCase(), avatarX, avatarY + 20);
    context.textAlign = 'start';
  }
  context.restore();

  // ---- Shield badge (right) ----
  drawShield(context, 990, 70, 170, accent);

  // ---- Top label + username + tier (center area) ----
  const contentX = 310;

  context.textBaseline = 'alphabetic';
  context.fillStyle = accent;
  context.font = fontString(17);
  context.letterSpacing = '4px';
  context.fillText(isTest ? 'MANAY SOCIETY  ·  TEST PREVIEW' : 'MANAY SOCIETY  ·  VOICE MILESTONE', contentX, 76);
  context.letterSpacing = '0px';

  context.fillStyle = '#F5F6F6';
  fitText(context, displayName, contentX, 132, 600, 38, 22);

  context.fillStyle = '#AAB3B6';
  context.font = fontString(14);
  context.letterSpacing = '3px';
  context.fillText(isTest ? 'PREVIEW TIER' : 'TIER BARU', contentX, 166);
  context.letterSpacing = '0px';

  context.fillStyle = accent;
  fitText(context, milestone.label.toUpperCase(), contentX, 232, 620, 68, 36);

  // ---- Progress bar ----
  const currentHours = milestone.hours * HOUR_MS;
  const nextHours = next ? next.hours * HOUR_MS : currentHours;
  const progress = next
    ? Math.max(0, Math.min(1, (totalMs - currentHours) / (nextHours - currentHours)))
    : 1;
  const progressX = 310;
  const progressY = 262;
  const progressWidth = 660;
  roundedRect(context, progressX, progressY, progressWidth, 10, 5);
  context.fillStyle = 'rgba(229, 236, 235, 0.22)';
  context.fill();
  if (progress > 0) {
    roundedRect(context, progressX, progressY, Math.max(10, progressWidth * progress), 10, 5);
    context.fillStyle = accent;
    context.fill();
  }
  context.fillStyle = '#D8DEDF';
  context.font = fontString(14);
  context.textAlign = 'right';
  context.fillText(`${Math.round(progress * 100)}%`, 976, 256);
  context.textAlign = 'start';

  // ---- Bottom 3 columns: TOTAL VOICE / GLOBAL RANK / BERIKUTNYA ----
  const colY = 318;
  const col1X = 310;
  const col2X = 560;
  const col3X = 810;

  context.fillStyle = '#AAB3B6';
  context.font = fontString(14);
  context.letterSpacing = '2px';
  context.fillText('TOTAL VOICE', col1X, colY);
  context.fillText('GLOBAL RANK', col2X, colY);
  context.fillText(next ? `BERIKUTNYA  ·  ${next.hours} JAM` : 'TIER MAKSIMAL', col3X, colY);
  context.letterSpacing = '0px';

  context.fillStyle = '#F5F6F6';
  context.font = fontString(30);
  context.fillText(formatHours(totalMs), col1X, colY + 42);
  context.fillText(rank ? `#${rank}` : '#—', col2X, colY + 42);
  fitText(context, next ? next.label.toUpperCase() : 'HALL OF FAME', col3X, colY + 42, 300, 26, 18);

  return canvas.toBuffer('image/png');
}

const RANK_COLORS = ['#F5C542', '#C0C7CC', '#CD7F32'];

async function loadAvatarImage(avatarUrl) {
  if (!avatarUrl) return null;
  try {
    const response = await fetch(avatarUrl);
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * Render a vertical leaderboard card: top members with their avatars, rank
 * medals and accumulated voice time.
 */
export async function renderVoiceLeaderboardCard({
  members,
  viewer = null,
  memberCount = 0,
  configEnabled = true,
}) {
  ensureFonts();

  const width = 1100;
  const headerHeight = 150;
  const entryHeight = 92;
  const footerHeight = 110;
  const height = headerHeight + members.length * entryHeight + footerHeight;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  // Background
  const background = await getBackground();
  const scale = Math.max(width / background.width, height / background.height);
  const bw = background.width * scale;
  const bh = background.height * scale;
  context.drawImage(background, (width - bw) / 2, (height - bh) / 2, bw, bh);
  context.fillStyle = 'rgba(8, 12, 14, 0.82)';
  context.fillRect(0, 0, width, height);

  // Card frame
  roundedRect(context, 30, 24, width - 60, height - 48, 32);
  context.fillStyle = 'rgba(14, 20, 22, 0.55)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = configEnabled ? 'rgba(214, 177, 94, 0.72)' : 'rgba(170, 179, 182, 0.6)';
  context.stroke();

  // Header
  context.fillStyle = '#D6B15E';
  context.font = fontString(18);
  context.letterSpacing = '5px';
  context.fillText('MANAY SOCIETY', 70, 78);
  context.letterSpacing = '0px';

  context.fillStyle = '#F5F6F6';
  context.font = fontString(42);
  context.fillText('Top Voice Leaderboard', 70, 128);

  // LIVE pill
  const liveText = 'LIVE';
  context.font = fontString(16);
  const liveWidth = context.measureText(liveText).width;
  const liveX = width - 70 - liveWidth - 28;
  const liveY = 104;
  roundedRect(context, liveX, liveY, liveWidth + 28, 30, 15);
  context.fillStyle = '#E04B4B';
  context.fill();
  context.fillStyle = '#FFFFFF';
  context.textAlign = 'center';
  context.fillText(liveText, liveX + (liveWidth + 28) / 2, liveY + 21);
  context.textAlign = 'start';

  context.fillStyle = '#AAB3B6';
  context.font = fontString(18);
  context.textAlign = 'right';
  context.fillText(`${memberCount} member terlacak`, width - 70, 78);
  context.textAlign = 'start';

  // Entries
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const y = headerHeight + i * entryHeight + 20;
    const isTop3 = i < 3;
    const accent = isTop3 ? RANK_COLORS[i] : '#5A6468';

    // Rank badge
    const badgeX = 80;
    const badgeY = y + 32;
    context.beginPath();
    context.arc(badgeX, badgeY, 24, 0, Math.PI * 2);
    context.fillStyle = accent;
    context.fill();
    context.fillStyle = '#0C1113';
    context.font = fontString(20);
    context.textAlign = 'center';
    context.fillText(`${i + 1}`, badgeX, badgeY + 7);
    context.textAlign = 'start';

    // Avatar
    const avatarX = 150;
    const avatarY = y + 32;
    const avatarRadius = 34;
    context.beginPath();
    context.arc(avatarX, avatarY, avatarRadius + 4, 0, Math.PI * 2);
    context.fillStyle = 'rgba(8, 12, 14, 0.9)';
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = accent;
    context.stroke();

    const avatar = await loadAvatarImage(m.avatarURL);
    context.save();
    context.beginPath();
    context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    context.clip();
    if (avatar) {
      context.drawImage(avatar, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    } else {
      context.fillStyle = '#33413D';
      context.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
      context.fillStyle = '#F5F5F5';
      context.font = fontString(28);
      context.textAlign = 'center';
      context.fillText((m.displayName || '?').slice(0, 1).toUpperCase(), avatarX, avatarY + 10);
      context.textAlign = 'start';
    }
    context.restore();

    // Name
    context.fillStyle = '#F5F6F6';
    fitText(context, m.displayName || 'Unknown', 210, y + 42, 560, 28, 18);

    // Duration (right)
    context.fillStyle = isTop3 ? accent : '#D8DEDF';
    context.font = fontString(28);
    context.textAlign = 'right';
    context.fillText(formatHours(m.totalMs), width - 70, y + 42);
    context.textAlign = 'start';

    // Divider
    if (i < members.length - 1) {
      context.fillStyle = 'rgba(255, 255, 255, 0.06)';
      context.fillRect(70, y + entryHeight - 8, width - 140, 1);
    }
  }

  // Footer: viewer rank + live marker
  const footerY = headerHeight + members.length * entryHeight + 40;
  if (viewer) {
    context.fillStyle = '#AAB3B6';
    context.font = fontString(18);
    context.fillText('RANK KAMU', 70, footerY);
    context.fillStyle = '#F5F6F6';
    context.font = fontString(32);
    context.fillText(`#${viewer.rank}`, 70, footerY + 40);
    context.fillStyle = '#D6B15E';
    context.font = fontString(24);
    context.fillText(formatHours(viewer.totalMs), 180, footerY + 40);
  }

  context.fillStyle = '#AAB3B6';
  context.font = fontString(18);
  context.textAlign = 'right';
  context.fillText('LIVE  ·  update tiap 1 menit', width - 70, footerY + 40);
  context.textAlign = 'start';

  return canvas.toBuffer('image/png');
}
