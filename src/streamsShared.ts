import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { getDirectoryHistory } from './history';
import { logger } from './logger';
import {
	createFallbackUploadMetadata,
	isUploadMetadata
} from './uploadMetadata';
import type { UploadMetadata } from './uploadTypes';

export const log = logger.init('streams');
export const dataDir = resolve(process.env.DATA_DIR ?? '/data/streams');
export const callbackPrefix = 'streams:';
export const vodMetadataFileName = 'vod-metadata.json';
export const previewByteLimit = 64 * 1024;
export const previewTextLimit = 3200;
export const browserRootLabel = '/data/streams';

const pathTokenStore = new Map<string, string>();
let pathTokenCounter = 0;

export type EntryKind = 'dir' | 'file';
export type SegmentUploadState = 'starting' | 'uploading' | 'done' | 'error';

export interface BrowserEntry {
	name: string;
	kind: EntryKind;
	absolutePath: string;
	sizeBytes?: number;
}

export interface UploadStatus {
	label: string;
	targetChatId: string | number;
	startedAtMs: number;
	totalBytes: number;
	uploadedBytes: number;
	state: SegmentUploadState;
	uploadedFiles?: number;
	totalFiles?: number;
	errorText?: string;
}

export function createPathToken(absolutePath: string): string {
	for (const [token, value] of pathTokenStore) {
		if (value === absolutePath) {
			return token;
		}
	}

	pathTokenCounter += 1;
	const token = pathTokenCounter.toString(36);
	pathTokenStore.set(token, absolutePath);
	if (pathTokenStore.size > 5000) {
		const oldest = pathTokenStore.keys().next().value;
		if (oldest) {
			pathTokenStore.delete(oldest);
		}
	}
	return token;
}

export function resolveSafePath(rawPath: string): string {
	const absolute = resolve(rawPath);
	if (absolute !== dataDir && !absolute.startsWith(`${dataDir}${sep}`)) {
		throw new Error('Некорректный путь');
	}
	return absolute;
}

export function getPathFromToken(token: string): string {
	const stored = pathTokenStore.get(token);
	if (!stored) {
		throw new Error('Путь устарел. Обновите список.');
	}
	return resolveSafePath(stored);
}

export function getPathFromTokenOrNull(token: string): string | null {
	try {
		return getPathFromToken(token);
	} catch {
		return null;
	}
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

export function statusBadgeForDir(absolutePath: string): string {
	const history = getDirectoryHistory(absolutePath);
	if (!history) {
		return '⬜';
	}
	if (history.status === 'done') {
		return '✅';
	}
	if (history.status === 'error') {
		return '❌';
	}
	return '🟡';
}

export function isUploadableSegmentName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return normalized.endsWith('.mp4') && normalized !== 'source.mp4';
}

export function isUploadableSegmentPath(absolutePath: string): boolean {
	return isUploadableSegmentName(basename(absolutePath));
}

export function collectUploadableSegments(entries: BrowserEntry[]): BrowserEntry[] {
	return entries.filter(entry => entry.kind === 'file' && isUploadableSegmentName(entry.name));
}

export async function listDirectory(absolutePath: string): Promise<BrowserEntry[]> {
	const entries = await readdir(absolutePath, { withFileTypes: true });
	const resolvedEntries = await Promise.all(
		entries.map(async entry => {
			const childPath = resolveSafePath(resolve(absolutePath, entry.name));
			if (entry.isDirectory()) {
				return { name: entry.name, kind: 'dir', absolutePath: childPath } satisfies BrowserEntry;
			}
			if (entry.isFile()) {
				const stats = await stat(childPath);
				return {
					name: entry.name,
					kind: 'file',
					absolutePath: childPath,
					sizeBytes: stats.size
				} satisfies BrowserEntry;
			}
			return undefined;
		})
	);
	const result: BrowserEntry[] = [];

	for (const entry of resolvedEntries) {
		if (entry) {
			result.push(entry);
		}
	}

	return result.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === 'dir' ? -1 : 1;
		}
		return a.name.localeCompare(b.name, 'ru');
	});
}

export async function listUploadableSegmentsInDirectory(absolutePath: string): Promise<BrowserEntry[]> {
	return collectUploadableSegments(await listDirectory(absolutePath));
}

export function buildBreadcrumb(absolutePath: string): string {
	if (absolutePath === dataDir) {
		return browserRootLabel;
	}
	const relative = absolutePath.slice(dataDir.length).replaceAll('\\', '/');
	return `${browserRootLabel}${relative}`;
}

export function buildFallbackMetadataForDirectory(absoluteDirPath: string): UploadMetadata {
	const history = getDirectoryHistory(absoluteDirPath);
	const title = history?.streamTitle?.trim() || basename(absoluteDirPath);
	return createFallbackUploadMetadata(title);
}

export async function buildMetadataFromDirectory(absoluteDirPath: string): Promise<UploadMetadata> {
	const metadataPath = `${absoluteDirPath}/${vodMetadataFileName}`;
	try {
		const raw = await readFile(metadataPath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (isUploadMetadata(parsed)) {
			return parsed;
		}
		log.warn('Invalid metadata json schema, fallback will be used', { metadataPath });
	} catch (error) {
		log.debug('Metadata json not available, fallback will be used', {
			metadataPath,
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return buildFallbackMetadataForDirectory(absoluteDirPath);
}