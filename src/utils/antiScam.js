// utils/antiScam.js
//
// Detektor anti-scam yang deterministik dan bebas efek samping (pure functions).
// Dipakai oleh services/antiScamService.js. Sengaja dibuat konservatif:
// hanya menandai pola yang punya sinyal kuat agar pesan/file/link normal
// tidak ikut terhapus.

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TESSDATA_DIR = path.join(__dirname, 'tessdata');

// Domain resmi Discord (dan turunannya) yang TIDAK pernah dianggap phishing.
export const OFFICIAL_DISCORD_DOMAINS = new Set([
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'discord.co',
  'discord.new',
  'discord.gift',
  'discord.gifts',
  'dis.gd',
  'discordstatus.com',
  'discordmerch.com',
  'discordactivities.com',
  'discordcdn.com',
  'discordpartygames.com',
]);

// TLD yang sering dipakai untuk kampanye phishing.
export const SUSPICIOUS_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'ru', 'xyz', 'top', 'click', 'link', 'cc',
  'buzz', 'rest', 'cyou', 'icu', 'sbs', 'monster', 'quest', 'cfd', 'bar',
  'casa', 'surf', 'work', 'website', 'space', 'online', 'site', 'live', 'fun',
  'store', 'shop', 'lol', 'cam', 'pw', 'ws', 'su', 'zip', 'mov',
]);

// Ekstensi yang bisa dieksekusi langsung / menjalankan perintah → selalu berbahaya.
export const DANGEROUS_FILE_EXTENSIONS = new Set([
  'exe', 'scr', 'pif', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'vbs', 'vbe',
  'vb', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'ps1xml', 'psm1', 'psd1', 'jar',
  'lnk', 'reg', 'hta', 'cpl', 'dll', 'sys', 'drv', 'ocx', 'gadget', 'msc',
  'apk', 'app', 'action', 'bin', 'iso', 'img', 'vhd', 'vhdx', 'ade', 'adp',
  'chm', 'inf', 'ins', 'isp', 'job', 'mde', 'msh', 'msh1', 'msh2', 'msp',
  'sct', 'shb', 'shs', 'u3p', 'ws', 'wsc', 'dex', 'arj',
]);

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif',
  'avif', 'svg', 'ico',
]);

// "foto.jpg.exe" — ekstensi ganda yang menyamarkan eksekutabel sebagai media.
const DOUBLE_EXTENSION_REGEX =
  /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heics?|heif|avif|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|mp[34]|wav|zip|rar|7z|html?)\s*\.\s*(?:exe|scr|bat|cmd|com|pif|msi|msp|mst|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|lnk|reg|hta|cpl|apk|dll|sys|dex)$/i;

// Pola nama domain yang meniru Discord (tidak termasuk Steam — dicek terpisah).
const LOOKALIKE_REGEX =
  /(d[il1]sc[o0]{1,3}rd|disc[o0]rd|discr[o0]d|dlscord|discordapp|discord-?nitro|nitro-?discord|discord-?gift|discordgift)/i;

// Kombinasi kata kunci scam yang khas (nitro/gift/steam).
const SCAM_KEYWORD_REGEX =
  /(free[-_\s]?nitro|nitro[-_\s]?(?:gift|free|gen|generator|giveaway|drop|airdrop|code)|steam[-_\s]?gift|free[-_\s]?gift|gift[-_\s]?(?:nitro|card|code)|claim[-_\s]?(?:nitro|reward|prize))/i;

const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

const HASH_THRESHOLD_DEFAULT = 6;

export function getExtension(name = '') {
  const clean = String(name).trim().toLowerCase();
  const idx = clean.lastIndexOf('.');
  if (idx === -1 || idx === clean.length - 1) return '';
  return clean.slice(idx + 1).replace(/[^a-z0-9]/g, '');
}

function normalizeLeet(value = '') {
  return String(value)
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/@/g, 'a')
    .replace(/vv/g, 'w');
}

export function isOfficialDomain(host = '') {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  for (const domain of OFFICIAL_DISCORD_DOMAINS) {
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function looksLikeDiscord(host = '') {
  const h = String(host).toLowerCase();
  const leet = normalizeLeet(h);
  return (
    h.includes('discord') ||
    leet.includes('discord') ||
    LOOKALIKE_REGEX.test(h) ||
    LOOKALIKE_REGEX.test(leet)
  );
}

function isIpLiteral(host = '') {
  const h = String(host).toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.startsWith('[') && h.endsWith(']')) return true;
  if (/^\d{8,10}$/.test(h)) return true; // desimal/IP tunggal
  return false;
}

/**
 * Ambil semua URL dari teks pesan.
 * @returns {Array<{raw: string, url: URL}>}
 */
export function extractUrls(text = '') {
  const matches = String(text).match(URL_REGEX) || [];
  const results = [];
  const seen = new Set();
  for (const match of matches) {
    const candidate = match.replace(/[.,;:!?)\]}'"`>]+$/g, '');
    if (!candidate) continue;
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
    try {
      const url = new URL(withScheme);
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({ raw: candidate, url });
    } catch {
      // bukan URL valid → abaikan
    }
  }
  return results;
}

function phishing(reason, host) {
  return { suspicious: true, type: 'link', reason, host };
}

/**
 * Analisa satu link. Hanya menandai pola phishing dengan sinyal kuat.
 * @param {string|URL} input
 */
export function analyzeLink(input) {
  let url;
  try {
    if (input instanceof URL) url = input;
    else {
      const value = String(input);
      url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    }
  } catch {
    return { suspicious: false, type: 'link', reason: null, host: null };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!host) return { suspicious: false, type: 'link', reason: null, host: null };

  // 1. Trik "@": link menyembunyikan host asli (http://discord.com@evil.com)
  if (url.username || url.password || url.host.includes('@')) {
    return phishing('URL menyembunyikan host asli (mengandung "@")', host);
  }

  // 2. Alamat IP langsung
  if (isIpLiteral(host)) {
    return phishing('URL memakai alamat IP langsung', host);
  }

  // 3. Punycode / homoglyph
  if (host.split('.').some((label) => label.startsWith('xn--'))) {
    return phishing('Domain punycode (kemungkinan homoglyph)', host);
  }

  const official = isOfficialDomain(host);

  // 4. Domain mirip Discord tapi bukan domain resmi
  if (!official && looksLikeDiscord(host)) {
    return phishing('Domain mirip Discord (tipuan phishing)', host);
  }

  // 5. Domain mirip Steam tapi bukan domain resmi
  const steamLike = /steam[-_]?(?:com+m?un[a-z0-9]{0,4}|com+unity|gift|powered)/i.test(host);
  const steamOfficial = /(^|\.)steamcommunity\.com$/.test(host) || /(^|\.)steampowered\.com$/.test(host);
  if (!official && steamLike && !steamOfficial) {
    return phishing('Domain mirip Steam (tipuan phishing)', host);
  }

  // 6. Kata kunci scam + TLD mencurigakan
  const tld = host.split('.').pop();
  if (!official && SCAM_KEYWORD_REGEX.test(host) && SUSPICIOUS_TLDS.has(tld)) {
    return phishing('Kombinasi kata scam + TLD mencurigakan', host);
  }

  // 7. Kata kunci scam pada domain non-resmi yang berpola (mis. free-nitro.gg)
  if (!official && SCAM_KEYWORD_REGEX.test(host) && /[-_0-9]/.test(host)) {
    return phishing('Nama domain mengandung pola scam', host);
  }

  return { suspicious: false, type: 'link', reason: null, host };
}

/**
 * Cek apakah attachment berupa gambar (berdasarkan content-type atau ekstensi).
 */
export function isImageAttachment(attachment) {
  const contentType = String(attachment?.contentType || '').toLowerCase();
  if (contentType.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(getExtension(attachment?.name));
}

/**
 * Analisa attachment non-gambar (file). Konservatif: hanya eksekutabel/script
 * berbahaya dan ekstensi ganda yang dianggap mencurigakan.
 */
export function analyzeAttachment(attachment) {
  const name = String(attachment?.name || '');
  const lower = name.toLowerCase().trim();
  const ext = getExtension(lower);

  if (DOUBLE_EXTENSION_REGEX.test(lower)) {
    return {
      suspicious: true,
      type: 'file',
      reason: 'Ekstensi ganda menyamarkan eksekutabel',
      fileName: name,
    };
  }

  if (ext && DANGEROUS_FILE_EXTENSIONS.has(ext)) {
    return {
      suspicious: true,
      type: 'file',
      reason: `File eksekutabel/script berbahaya (.${ext})`,
      fileName: name,
    };
  }

  return { suspicious: false, type: 'file', reason: null, fileName: name };
}

/**
 * Deteksi payload eksekutabel di balik file yang diklaim sebagai gambar.
 * @returns {string|null} nama format jika terdeteksi
 */
export function detectExecutablePayload(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // Windows PE (MZ)
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'Windows PE (MZ)';
  // Linux ELF
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return 'ELF';
  // Mach-O
  const magic = buffer.readUInt32BE(0);
  if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) return 'Mach-O';
  // Shebang script
  if (buffer[0] === 0x23 && buffer[1] === 0x21) return 'Script (shebang)';
  return null;
}

/**
 * Hitung dHash (perceptual hash) dari buffer gambar → 16 karakter hex.
 * Memakai @napi-rs/canvas secara lazy agar modul tetap bisa diuji tanpa binary.
 */
export async function computeDHash(buffer) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(buffer);
  const width = 9;
  const height = 8;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  let bits = '';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = (y * width + x) * 4;
      const right = (y * width + x + 1) * 4;
      const leftGray = 0.299 * data[left] + 0.587 * data[left + 1] + 0.114 * data[left + 2];
      const rightGray = 0.299 * data[right] + 0.587 * data[right + 1] + 0.114 * data[right + 2];
      bits += leftGray > rightGray ? '1' : '0';
    }
  }

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Jarak Hamming antara dua hash hex (semakin kecil semakin mirip).
 */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * Cari hash kandidat yang mirip (near-duplicate) di dalam daftar signature.
 */
export function findMatchingHash(hash, candidates = [], threshold = HASH_THRESHOLD_DEFAULT) {
  if (!hash) return null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (hashDistance(hash, candidate.toLowerCase()) <= threshold) return candidate;
  }
  return null;
}

// --- OCR: deteksi screenshot scam (withdrawal crypto palsu, giveaway selebriti palsu, dll.) ---
// Pola teks scam beserta skornya. Hanya menandai gambar sebagai scam bila
// total skor tinggi ATAU banyak kategori berbeda muncul sekaligus, agar
// screenshot crypto normal tidak ikut terhapus.
const OCR_SCAM_PATTERNS = [
  // Layar "withdrawal success" / penarikan berhasil — sinyal sangat kuat.
  { pattern: /withdraw(?:al)?\s*success/i, score: 5, category: 'withdrawal' },
  { pattern: /withdraw(?:al)?\s*successfully/i, score: 5, category: 'withdrawal' },
  { pattern: /penarikan\s*berhasil/i, score: 5, category: 'withdrawal' },
  { pattern: /receive\s*usdt/i, score: 3, category: 'withdrawal' },
  { pattern: /enter\s*wallet\s*address/i, score: 3, category: 'withdrawal' },
  { pattern: /wallet\s*address/i, score: 2, category: 'withdrawal' },
  { pattern: /withdraw(?:al)?/i, score: 1, category: 'withdrawal' },

  // Token kripto.
  { pattern: /\busdt\b/i, score: 1, category: 'crypto' },
  { pattern: /\btether\b/i, score: 1, category: 'crypto' },
  { pattern: /\btrx\b|\btron\b/i, score: 1, category: 'crypto' },
  { pattern: /\bbitcoin\b|\bbtc\b/i, score: 1, category: 'crypto' },
  { pattern: /\bethereum\b|\beth\b/i, score: 1, category: 'crypto' },
  { pattern: /\bcrypto(?:currency)?\b/i, score: 1, category: 'crypto' },

  // Bonus / kode promo.
  { pattern: /promo\s*code/i, score: 3, category: 'bonus' },
  { pattern: /kode\s*promo/i, score: 3, category: 'bonus' },
  { pattern: /activate\s*(?:code|bonus)/i, score: 3, category: 'bonus' },
  { pattern: /claim\s*(?:reward|bonus|your)/i, score: 2, category: 'bonus' },
  { pattern: /\bbonus(?:es)?\b/i, score: 1, category: 'bonus' },

  // Giveaway / airdrop.
  { pattern: /giving\s*away/i, score: 3, category: 'giveaway' },
  { pattern: /\bgiveaway\b/i, score: 2, category: 'giveaway' },
  { pattern: /\bairdrop\b/i, score: 2, category: 'giveaway' },

  // Selebriti / tokoh yang sering dijadikan palsu giveaway.
  { pattern: /mrbeast|elon\s*musk|mark\s*zuckerberg|vitalik/i, score: 1, category: 'celebrity' },
];

const OCR_SCORE_THRESHOLD = 8;
const OCR_STRONG_THRESHOLD = 5;

/**
 * Analisa teks hasil OCR untuk mendeteksi pola scam.
 * @returns {{score:number, categories:string[]}|null}
 */
export function analyzeOcrText(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();

  let score = 0;
  let hasStrong = false;
  const categories = new Set();
  for (const { pattern, score: s, category } of OCR_SCAM_PATTERNS) {
    if (pattern.test(lower)) {
      score += s;
      categories.add(category);
      if (s >= 3) hasStrong = true;
    }
  }

  // Hanya scam bila: ada satu sinyal kuat (skor≥3) + total≥5, ATAU total skor≥8.
  const suspicious = (hasStrong && score >= OCR_STRONG_THRESHOLD) || score >= OCR_SCORE_THRESHOLD;
  if (!suspicious) return null;
  return { score, categories: [...categories] };
}

// Worker OCR singleton (lazy) dengan antrian agar tidak membanjiri worker.
let _ocrWorker = null;
let _ocrReady = null;
let _ocrChain = Promise.resolve();

async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  if (!_ocrReady) {
    _ocrReady = (async () => {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      _ocrWorker = worker;
      return worker;
    })();
  }
  return _ocrReady;
}

/**
 * Jalankan OCR terhadap buffer gambar. Panggilan diserialisasi lewat antrian.
 * @returns {Promise<string>} teks yang dikenali (kosong bila gagal).
 */
export async function ocrImage(buffer) {
  const task = _ocrChain.then(async () => {
    try {
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(buffer);
      return data?.text || '';
    } catch {
      return '';
    }
  });
  _ocrChain = task.catch(() => {});
  return task;
}

/**
 * Analisa buffer gambar:
 * 1. payload eksekutabel yang menyamar sebagai gambar,
 * 2. cocokkan dHash dengan signature gambar scam,
 * 3. OCR teks untuk mendeteksi screenshot scam (withdrawal crypto, giveaway, dll.).
 */
export async function analyzeImageBuffer(buffer, options = {}) {
  const { knownHashes = [], hashThreshold = HASH_THRESHOLD_DEFAULT } = options;

  const payload = detectExecutablePayload(buffer);
  if (payload) {
    return {
      suspicious: true,
      type: 'photo',
      reason: `Gambar palsu berisi payload eksekutabel (${payload})`,
      hash: null,
    };
  }

  let hash = null;
  try {
    hash = await computeDHash(buffer);
  } catch {
    hash = null;
  }

  if (hash && knownHashes.length) {
    const matched = findMatchingHash(hash, knownHashes, hashThreshold);
    if (matched) {
      return {
        suspicious: true,
        type: 'photo',
        reason: 'Cocok dengan signature gambar scam',
        hash,
        matched,
      };
    }
  }

  // Layer OCR: deteksi screenshot scam berdasarkan teks di gambar.
  const ocrText = await ocrImage(buffer);
  const ocrResult = analyzeOcrText(ocrText);
  if (ocrResult) {
    return {
      suspicious: true,
      type: 'photo',
      reason: `Screenshot scam terdeteksi (OCR: skor ${ocrResult.score}, kategori ${ocrResult.categories.join(', ')})`,
      hash,
      ocr: ocrResult,
    };
  }

  return { suspicious: false, type: 'photo', reason: null, hash };
}

export { HASH_THRESHOLD_DEFAULT };
