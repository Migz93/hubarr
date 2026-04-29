import sharp from "sharp";
import type { MediaType } from "../shared/types.js";

const POSTER_WIDTH = 1000;
const POSTER_HEIGHT = 1500;
const MAX_TITLE_LINES = 3;

const THEMES: Record<MediaType, {
  label: string;
  accent: string;
  accentSoft: string;
  background: string;
  glow: string;
}> = {
  movie: {
    label: "MOVIES",
    accent: "#4ade80",
    accentSoft: "#bbf7d0",
    background: "#07130d",
    glow: "#12452a"
  },
  show: {
    label: "SHOWS",
    accent: "#5ec8ff",
    accentSoft: "#b5e9ff",
    background: "#0d1320",
    glow: "#123f57"
  }
};

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeCollectionName(value: string | null | undefined): string {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned || "Watchlist";
}

function wrapTitle(value: string): string[] {
  const words = value.split(" ").filter(Boolean);
  if (words.length <= MAX_TITLE_LINES) {
    return words;
  }

  return [
    ...words.slice(0, MAX_TITLE_LINES - 1),
    words.slice(MAX_TITLE_LINES - 1).join(" ")
  ];
}

function buildTitleText(title: string): { lines: string[]; fontSize: number; lineHeight: number } {
  const lines = wrapTitle(title);
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const fittedSize = Math.floor(1220 / longestLine);

  if (lines.length === 1) {
    return { lines, fontSize: Math.min(132, fittedSize), lineHeight: 146 };
  }
  if (lines.length === 2) {
    return { lines, fontSize: Math.min(104, fittedSize), lineHeight: 116 };
  }
  return { lines, fontSize: Math.min(78, fittedSize), lineHeight: 90 };
}

function buildIcon(mediaType: MediaType, accent: string): string {
  if (mediaType === "movie") {
    return `
      <path d="M500 205l75 153 169 25-122 119 29 168-151-79-151 79 29-168-122-119 169-25z" fill="none" stroke="${accent}" stroke-width="28" stroke-linejoin="round"/>
    `;
  }

  return `
    <rect x="230" y="302" width="540" height="320" rx="34" fill="none" stroke="${accent}" stroke-width="24"/>
    <rect x="282" y="356" width="436" height="188" rx="18" fill="${accent}" opacity="0.14"/>
    <path d="M404 302l-92 -96M596 302l92 -96" stroke="${accent}" stroke-width="22" stroke-linecap="round"/>
    <circle cx="360" cy="580" r="15" fill="${accent}"/>
    <circle cx="640" cy="580" r="15" fill="${accent}"/>
  `;
}

export async function generateCollectionPoster(params: {
  collectionName: string | null | undefined;
  mediaType: MediaType;
}): Promise<Buffer> {
  const theme = THEMES[params.mediaType];
  const title = normalizeCollectionName(params.collectionName);
  const text = buildTitleText(title);
  const firstLineY = 852 - ((text.lines.length - 1) * text.lineHeight) / 2;
  const titleLines = text.lines
    .map((line, index) => (
      `<text x="500" y="${firstLineY + index * text.lineHeight}" text-anchor="middle" class="title">${escapeSvgText(line)}</text>`
    ))
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" viewBox="0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}">
      <defs>
        <radialGradient id="glow" cx="50%" cy="35%" r="72%">
          <stop offset="0%" stop-color="${theme.glow}" stop-opacity="1"/>
          <stop offset="58%" stop-color="${theme.background}" stop-opacity="1"/>
          <stop offset="100%" stop-color="#08090d" stop-opacity="1"/>
        </radialGradient>
        <linearGradient id="band" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.92"/>
          <stop offset="100%" stop-color="${theme.accentSoft}" stop-opacity="0.72"/>
        </linearGradient>
        <style>
          .label { font: 700 54px Arial, Helvetica, sans-serif; letter-spacing: 10px; fill: ${theme.accentSoft}; }
          .title { font: 800 ${text.fontSize}px Arial, Helvetica, sans-serif; fill: #f8f8f4; }
        </style>
      </defs>
      <rect width="1000" height="1500" fill="url(#glow)"/>
      <rect x="68" y="68" width="864" height="1364" rx="54" fill="none" stroke="url(#band)" stroke-width="10"/>
      <rect x="118" y="118" width="764" height="1264" rx="34" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
      <g opacity="0.98">${buildIcon(params.mediaType, theme.accent)}</g>
      ${titleLines}
      <rect x="305" y="1096" width="390" height="8" rx="4" fill="${theme.accent}"/>
      <text x="500" y="1268" text-anchor="middle" class="label">${theme.label}</text>
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}
