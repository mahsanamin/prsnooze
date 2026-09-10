"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = "settings.json";
const AVATAR_FILE = "profile-avatar.bin";
const MAX_AVATAR_BYTES = 512 * 1024;

const AVATAR_SEEDS = [
  ["aurora", "Aurora", "b6e3f4"],
  ["ember", "Ember", "ffdfbf"],
  ["moss", "Moss", "a7f3d0"],
  ["nova", "Nova", "c0aede"],
  ["coral", "Coral", "ffd5dc"],
  ["orbit", "Orbit", "bfdbfe"],
  ["saffron", "Saffron", "fde68a"],
  ["violet", "Violet", "ddd6fe"],
  ["lagoon", "Lagoon", "a5f3fc"],
  ["rose", "Rose", "fbcfe8"],
  ["indigo", "Indigo", "c7d2fe"],
  ["lime", "Lime", "d9f99d"],
  ["sky", "Sky", "bae6fd"],
  ["peach", "Peach", "fed7aa"],
  ["iris", "Iris", "e9d5ff"],
  ["mint", "Mint", "99f6e4"],
  ["blush", "Blush", "fecdd3"],
  ["cloud", "Cloud", "d1d4f9"],
  ["ruby", "Ruby", "fee2e2"],
  ["orchid", "Orchid", "f5d0fe"],
];

const AVATARS = Object.freeze(AVATAR_SEEDS.map(([id, label]) => ({
  id,
  label,
  url: `/avatars/${id}.svg`,
})));

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function stableAvatarId(instanceId) {
  const digest = crypto.createHash("sha256").update(String(instanceId || "prsnooze")).digest();
  return AVATARS[digest.readUInt32BE(0) % AVATARS.length].id;
}

function defaults({ instanceId, initialConcurrency = 1 } = {}) {
  return {
    acceptingReviews: true,
    minUsageRemainingPct: 0,
    maxConcurrentReviews: clampInt(initialConcurrency, 1, 4, 1),
    avatar: { kind: "preset", id: stableAvatarId(instanceId) },
  };
}

function normalizeSettings(value, options = {}) {
  const base = defaults(options);
  const raw = value && typeof value === "object" ? value : {};
  const avatar = raw.avatar && typeof raw.avatar === "object" ? raw.avatar : {};
  const presetExists = AVATARS.some((candidate) => candidate.id === avatar.id);
  const custom = avatar.kind === "custom" && ["image/png", "image/jpeg", "image/webp"].includes(avatar.mime);
  return {
    acceptingReviews: typeof raw.acceptingReviews === "boolean" ? raw.acceptingReviews : base.acceptingReviews,
    minUsageRemainingPct: clampInt(raw.minUsageRemainingPct, 0, 100, base.minUsageRemainingPct),
    maxConcurrentReviews: clampInt(raw.maxConcurrentReviews, 1, 4, base.maxConcurrentReviews),
    avatar: custom
      ? { kind: "custom", mime: avatar.mime, version: clampInt(avatar.version, 1, Number.MAX_SAFE_INTEGER, 1) }
      : { kind: "preset", id: presetExists ? avatar.id : base.avatar.id },
  };
}

function loadSettings({ dataHome, instanceId, initialConcurrency = 1 } = {}) {
  const options = { instanceId, initialConcurrency };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataHome, SETTINGS_FILE), "utf8"));
    const settings = normalizeSettings(raw, options);
    if (settings.avatar.kind === "custom" && !fs.existsSync(path.join(dataHome, AVATAR_FILE))) {
      settings.avatar = defaults(options).avatar;
    }
    return settings;
  } catch {
    return defaults(options);
  }
}

function saveSettings(dataHome, settings) {
  fs.mkdirSync(dataHome, { recursive: true });
  const target = path.join(dataHome, SETTINGS_FILE);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

function decodeAvatarDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Upload a PNG, JPEG, or WebP image.");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > MAX_AVATAR_BYTES) {
    throw new Error("Avatar must be 512 KB or smaller after resizing.");
  }
  const magicOk =
    (match[1] === "image/png" && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (match[1] === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8) ||
    (match[1] === "image/webp" && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP");
  if (!magicOk) throw new Error("The uploaded file does not match its image type.");
  return { mime: match[1], data };
}

function saveCustomAvatar(dataHome, dataUrl, previousVersion = 0) {
  const decoded = decodeAvatarDataUrl(dataUrl);
  fs.mkdirSync(dataHome, { recursive: true });
  const target = path.join(dataHome, AVATAR_FILE);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, decoded.data, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return { kind: "custom", mime: decoded.mime, version: Math.max(Date.now(), Number(previousVersion) + 1) };
}

function publicSettings(settings) {
  const preset = settings.avatar.kind === "preset"
    ? AVATARS.find((candidate) => candidate.id === settings.avatar.id) || AVATARS[0]
    : null;
  return {
    profile: {
      avatarId: preset?.id || null,
      avatarUrl: preset?.url || `/api/profile/avatar?v=${settings.avatar.version}`,
      custom: settings.avatar.kind === "custom",
      choices: AVATARS,
      attribution: {
        label: "Personas by Draftbit via DiceBear (CC BY 4.0)",
        url: "https://www.dicebear.com/styles/personas/",
      },
    },
    admission: {
      acceptingReviews: settings.acceptingReviews,
      minUsageRemainingPct: settings.minUsageRemainingPct,
      maxConcurrentReviews: settings.maxConcurrentReviews,
    },
  };
}

module.exports = {
  AVATARS,
  AVATAR_FILE,
  MAX_AVATAR_BYTES,
  decodeAvatarDataUrl,
  loadSettings,
  normalizeSettings,
  publicSettings,
  saveCustomAvatar,
  saveSettings,
  stableAvatarId,
};
