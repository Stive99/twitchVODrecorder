import type { YtInfo } from './vodJobTypes';

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function toHms(totalSeconds: number): string {
	const sec = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function toHm(totalSeconds: number): string {
	const sec = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function sanitizeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

export function sanitizeFileName(value: string): string {
	const withoutInvalidChars = Array.from(value, ch => {
		const code = ch.charCodeAt(0);
		const isControl = code >= 0 && code <= 31;
		const isInvalidWinChar = /[<>:"/\\|?*]/.test(ch);
		return isControl || isInvalidWinChar ? ' ' : ch;
	}).join('');
	const cleaned = withoutInvalidChars
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[. ]+$/g, '');
	const normalized = cleaned.length > 0 ? cleaned : 'stream';
	return normalized.slice(0, 80);
}

function normalizeAsciiSlug(value: string): string {
	const decomposed = value.normalize('NFKD');
	const ascii = Array.from(decomposed)
		.filter(ch => ch.charCodeAt(0) <= 0x7f)
		.join('');
	const slug = ascii
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-');
	return slug;
}

function stableHashHex(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildChunkBaseName(streamTitle: string, sourceId: string): string {
	const fallbackBase = normalizeAsciiSlug(sourceId) || 'stream';
	const titleSlug = normalizeAsciiSlug(streamTitle);
	const base = titleSlug.length > 0 ? titleSlug : fallbackBase;
	const hash = stableHashHex(`${sourceId}|${streamTitle}`);
	const combined = `${base}-${hash}`;
	return sanitizeFileName(combined).slice(0, 80);
}

export function parseSourceId(url: string): string {
	const vodMatch = url.match(/twitch\.tv\/videos\/(\d+)/i);
	if (vodMatch?.[1]) {
		return `vod-${vodMatch[1]}`;
	}

	const clipMatch = url.match(
		/twitch\.tv\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)/i
	);
	if (clipMatch?.[1]) {
		return `clip-${sanitizeId(clipMatch[1])}`;
	}

	const shortClipMatch = url.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i);
	if (shortClipMatch?.[1]) {
		return `clip-${sanitizeId(shortClipMatch[1])}`;
	}

	return `media-${Date.now()}`;
}

export function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	return JSON.stringify(error);
}

export function trimOutput(value: string): string {
	return value.trim().slice(0, 1600);
}

export function formatStreamDate(info: YtInfo): string | undefined {
	const ts = info.release_timestamp ?? info.timestamp;
	if (typeof ts === 'number') {
		const date = new Date(ts * 1000);
		const yyyy = date.getFullYear();
		const mm = String(date.getMonth() + 1).padStart(2, '0');
		const dd = String(date.getDate()).padStart(2, '0');
		const hh = String(date.getHours()).padStart(2, '0');
		const mi = String(date.getMinutes()).padStart(2, '0');
		return `${dd}-${mm}-${yyyy} ${hh}:${mi}`;
	}

	if (typeof info.upload_date === 'string' && info.upload_date.length === 8) {
		const yyyy = info.upload_date.slice(0, 4);
		const mm = info.upload_date.slice(4, 6);
		const dd = info.upload_date.slice(6, 8);
		return `${dd}-${mm}-${yyyy}`;
	}

	return undefined;
}

export function parseDurationStringToSeconds(value: string): number | undefined {
	const clean = value.trim();
	if (!clean) {
		return undefined;
	}

	const parts = clean.split(':').map(part => Number(part));
	if (parts.some(part => Number.isNaN(part) || part < 0)) {
		return undefined;
	}

	if (parts.length === 3) {
		const h = parts[0] ?? 0;
		const m = parts[1] ?? 0;
		const s = parts[2] ?? 0;
		return h * 3600 + m * 60 + s;
	}
	if (parts.length === 2) {
		const m = parts[0] ?? 0;
		const s = parts[1] ?? 0;
		return m * 60 + s;
	}
	if (parts.length === 1) {
		return parts[0] ?? undefined;
	}

	return undefined;
}

export function resolveDurationSeconds(info: YtInfo): number | undefined {
	if (
		typeof info.duration === 'number' &&
		Number.isFinite(info.duration) &&
		info.duration > 0
	) {
		return Math.floor(info.duration);
	}

	if (typeof info.duration_string === 'string') {
		return parseDurationStringToSeconds(info.duration_string);
	}

	return undefined;
}

function isNumericOnly(value: string): boolean {
	return /^\d+$/.test(value);
}

function normalizeChannelName(value: string): string {
	return value.trim().replace(/^@/, '');
}

export function resolveChannelName(info: YtInfo): string {
	const rawCandidates = [
		info.uploader,
		info.channel,
		info.uploader_id,
		info.channel_id
	];
	const candidates = rawCandidates
		.filter(
			(value): value is string =>
				typeof value === 'string' && value.trim().length > 0
		)
		.map(normalizeChannelName);

	const preferred = candidates.find(value => !isNumericOnly(value));
	return preferred ?? candidates[0] ?? 'Unknown';
}

export function resolveChannelUrl(info: YtInfo): string | undefined {
	if (
		typeof info.channel_url === 'string' &&
		info.channel_url.trim().length > 0
	) {
		return info.channel_url.trim();
	}
	if (
		typeof info.uploader_url === 'string' &&
		info.uploader_url.trim().length > 0
	) {
		return info.uploader_url.trim();
	}

	const slugSource = resolveChannelName(info);
	const slug = slugSource.trim();
	if (slug && /^[A-Za-z0-9_]+$/.test(slug) && !isNumericOnly(slug)) {
		return `https://www.twitch.tv/${slug}`;
	}

	return undefined;
}

function normalizeMetadataText(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function resolveStreamCategory(info: YtInfo): string {
	const candidates: Array<string | undefined> = [
		info.categories?.find(value => typeof value === 'string' && value.trim().length > 0),
		info.category,
		info.game,
		info.genre
	];
	for (const candidate of candidates) {
		const normalized = normalizeMetadataText(candidate);
		if (normalized) {
			return normalized;
		}
	}

	const chapterCategory = info.chapters
		?.map(chapter => normalizeMetadataText(chapter.title))
		.find((title): title is string => typeof title === 'string');
	if (chapterCategory) {
		return chapterCategory;
	}

	return 'Unknown';
}

export function resolveStreamTitle(info: YtInfo, category: string): string {
	const categoryLower = category.trim().toLowerCase();
	const candidates: Array<string | undefined> = [info.title, info.fulltitle];
	const normalizedCandidates = candidates
		.map(normalizeMetadataText)
		.filter((value): value is string => typeof value === 'string');

	const preferred = normalizedCandidates.find(
		value => value.toLowerCase() !== categoryLower
	);
	if (preferred) {
		return preferred;
	}

	const descriptionTitle = normalizeMetadataText(info.description?.split('\n')[0]);
	if (descriptionTitle && descriptionTitle.toLowerCase() !== categoryLower) {
		return descriptionTitle;
	}

	return normalizedCandidates[0] ?? `VOD ${info.id ?? Date.now()}`;
}

export function extractVodUrl(text: string): string | null {
	const match = text.match(
		/https?:\/\/(?:www\.)?(?:twitch\.tv\/videos\/\d+|twitch\.tv\/[A-Za-z0-9_]+\/clip\/[A-Za-z0-9_-]+|clips\.twitch\.tv\/[A-Za-z0-9_-]+)/i
	);
	return match?.[0] ?? null;
}

export function formatBytes(value: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let idx = 0;
	while (size >= 1024 && idx < units.length - 1) {
		size /= 1024;
		idx += 1;
	}
	return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}