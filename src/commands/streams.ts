import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { DEFAULT_TARGET_CHAT_ID, OWNER_USER_ID } from '../config';
import { getDirectoryHistory } from '../history';
import { logger } from '../logger';
import {
	createFallbackUploadMetadata,
	isUploadMetadata
} from '../uploadMetadata';
import { uploadVideoFiles } from '../uploadTransport';
import type { UploadFileDescriptor, UploadMetadata } from '../uploadTypes';
import type { BotCommand } from './types';

const log = logger.init('streams');
const dataDir = resolve(process.env.DATA_DIR ?? '/data/streams');
const callbackPrefix = 'streams:';
const pathTokenStore = new Map<string, string>();
let pathTokenCounter = 0;
const vodMetadataFileName = 'vod-metadata.json';

type EntryKind = 'dir' | 'file';
type SegmentUploadState = 'starting' | 'uploading' | 'done' | 'error';

interface BrowserEntry {
	name: string;
	kind: EntryKind;
	absolutePath: string;
	sizeBytes?: number;
}

interface UploadStatus {
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

function createPathToken(absolutePath: string): string {
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

function resolveSafePath(rawPath: string): string {
	const absolute = resolve(rawPath);
	if (absolute !== dataDir && !absolute.startsWith(`${dataDir}${sep}`)) {
		throw new Error('Некорректный путь');
	}
	return absolute;
}

function getPathFromToken(token: string): string {
	const stored = pathTokenStore.get(token);
	if (!stored) {
		throw new Error('Путь устарел. Обновите список.');
	}
	return resolveSafePath(stored);
}

function getPathFromTokenOrNull(token: string): string | null {
	try {
		return getPathFromToken(token);
	} catch {
		return null;
	}
}

function formatBytes(value: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let idx = 0;
	while (size >= 1024 && idx < units.length - 1) {
		size /= 1024;
		idx += 1;
	}
	return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function statusBadgeForDir(absolutePath: string): string {
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

function isUploadableSegmentName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return normalized.endsWith('.mp4') && normalized !== 'source.mp4';
}

function isUploadableSegmentPath(absolutePath: string): boolean {
	return isUploadableSegmentName(basename(absolutePath));
}

function collectUploadableSegments(entries: BrowserEntry[]): BrowserEntry[] {
	return entries.filter(entry => entry.kind === 'file' && isUploadableSegmentName(entry.name));
}

function renderProgressBar(percent: number): string {
	const width = 12;
	const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
	const filled = Math.round((clamped / 100) * width);
	return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function formatDurationMs(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const hh = Math.floor(totalSec / 3600);
	const mm = Math.floor((totalSec % 3600) / 60);
	const ss = totalSec % 60;
	if (hh > 0) {
		return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
	}
	return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function buildUploadText(progress: UploadStatus): string {
	const percent =
		progress.totalBytes > 0
			? Math.floor((progress.uploadedBytes / progress.totalBytes) * 100)
			: 0;
	const elapsed = formatDurationMs(Date.now() - progress.startedAtMs);
	const stateLabel =
		progress.state === 'starting'
			? 'подготовка'
			: progress.state === 'uploading'
				? 'загрузка'
				: progress.state === 'done'
					? 'завершено'
					: 'ошибка';

	const lines = [
		'📤 Загрузка',
		`Объект: ${progress.label}`,
		`Куда: ${progress.targetChatId}`,
		'',
		`Статус: ${stateLabel}`,
		`Прогресс: ${renderProgressBar(percent)} ${Math.max(0, Math.min(100, percent))}%`,
		`Передано: ${formatBytes(progress.uploadedBytes)} / ${formatBytes(progress.totalBytes)}`,
		`Время: ${elapsed}`
	];

	if (typeof progress.uploadedFiles === 'number' && typeof progress.totalFiles === 'number') {
		lines.push(`Файлы: ${progress.uploadedFiles}/${progress.totalFiles}`);
	}

	if (progress.errorText) {
		lines.push('', `Ошибка: ${progress.errorText}`);
	}

	return lines.join('\n');
}

function buildFallbackMetadataForDirectory(absoluteDirPath: string): UploadMetadata {
	const history = getDirectoryHistory(absoluteDirPath);
	const title = history?.streamTitle?.trim() || basename(absoluteDirPath);
	return createFallbackUploadMetadata(title);
}

async function buildMetadataFromDirectory(absoluteDirPath: string): Promise<UploadMetadata> {
	const metadataPath = `${absoluteDirPath}/${vodMetadataFileName}`;
	try {
		const raw = await readFile(metadataPath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (isUploadMetadata(parsed)) {
			return parsed;
		}
		log.warn('Invalid metadata json schema, fallback will be used', { metadataPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.debug('Metadata json not available, fallback will be used', {
			metadataPath,
			error: message
		});
	}
	return buildFallbackMetadataForDirectory(absoluteDirPath);
}

async function listDirectory(absolutePath: string): Promise<BrowserEntry[]> {
	const entries = await readdir(absolutePath, { withFileTypes: true });
	const result: BrowserEntry[] = [];
	for (const entry of entries) {
		const childPath = resolveSafePath(resolve(absolutePath, entry.name));
		if (entry.isDirectory()) {
			result.push({ name: entry.name, kind: 'dir', absolutePath: childPath });
			continue;
		}
		if (entry.isFile()) {
			const stats = await stat(childPath);
			result.push({
				name: entry.name,
				kind: 'file',
				absolutePath: childPath,
				sizeBytes: stats.size
			});
		}
	}
	return result.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === 'dir' ? -1 : 1;
		}
		return a.name.localeCompare(b.name, 'ru');
	});
}

async function listUploadableSegmentsInDirectory(absolutePath: string): Promise<BrowserEntry[]> {
	const entries = await listDirectory(absolutePath);
	return collectUploadableSegments(entries);
}

function buildBreadcrumb(absolutePath: string): string {
	if (absolutePath === dataDir) {
		return '/data/streams';
	}
	const relative = absolutePath.slice(dataDir.length).replaceAll('\\', '/');
	return `/data/streams${relative}`;
}

async function buildDirectoryView(absolutePath: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
	const entries = await listDirectory(absolutePath);
	const dirCount = entries.filter(item => item.kind === 'dir').length;
	const fileCount = entries.length - dirCount;
	const lines: string[] = [`📂 ${buildBreadcrumb(absolutePath)}`, `Папок: ${dirCount}, файлов: ${fileCount}`];

	const history = getDirectoryHistory(absolutePath);
	if (history) {
		const label =
			history.status === 'done'
				? 'загрузки завершены'
				: history.status === 'error'
					? 'ошибка загрузки'
					: 'в процессе';
		lines.push(`Статус папки: ${label}`);
	}

	const keyboard = new InlineKeyboard();
	for (const entry of entries) {
		const token = createPathToken(entry.absolutePath);
		if (entry.kind === 'dir') {
			keyboard.text(`${statusBadgeForDir(entry.absolutePath)} 📁 ${entry.name}`, `${callbackPrefix}open:${token}`);
			keyboard.row();
			continue;
		}
		keyboard.text(`📄 ${entry.name} (${formatBytes(entry.sizeBytes ?? 0)})`, `${callbackPrefix}file:${token}`);
		keyboard.row();
	}

	const dirToken = createPathToken(absolutePath);
	const uploadableSegments = collectUploadableSegments(entries);
	if (uploadableSegments.length > 0) {
		keyboard.text(`⬆️ Загрузить сегменты (${uploadableSegments.length})`, `${callbackPrefix}uploaddir:${dirToken}`);
		keyboard.row();
	}

	if (absolutePath !== dataDir) {
		const parentPath = resolveSafePath(resolve(absolutePath, '..'));
		const parentToken = createPathToken(parentPath);
		keyboard.text('↩️ Назад', `${callbackPrefix}open:${parentToken}`);
		keyboard.text('🗑 Удалить папку', `${callbackPrefix}deldir:${dirToken}`);
		keyboard.row();
	}

	const currentToken = createPathToken(absolutePath);
	keyboard.text('🔄 Обновить', `${callbackPrefix}open:${currentToken}`);
	return { text: lines.join('\n'), keyboard };
}

async function buildFileView(absolutePath: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
	const info = await stat(absolutePath);
	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const fileToken = createPathToken(absolutePath);
	const parentToken = createPathToken(parentPath);
	const keyboard = new InlineKeyboard()
		.text('↩️ В папку', `${callbackPrefix}open:${parentToken}`)
		.text('🗑 Удалить файл', `${callbackPrefix}delfile:${fileToken}`);

	if (isUploadableSegmentPath(absolutePath)) {
		keyboard.row();
		keyboard.text('⬆️ Загрузить сегмент', `${callbackPrefix}uploadseg:${fileToken}`);
	}

	const lines = [
		`📄 ${buildBreadcrumb(absolutePath)}`,
		`Размер: ${formatBytes(info.size)}`,
		`Изменен: ${new Date(info.mtimeMs).toLocaleString('ru-RU')}`
	];
	return { text: lines.join('\n'), keyboard };
}

async function editBrowserMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
	try {
		await ctx.editMessageText(text, { reply_markup: keyboard });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('message is not modified')) {
			return;
		}
		throw error;
	}
}

async function uploadSegmentWithProgress(ctx: Context, absolutePath: string): Promise<void> {
	const ownerChatId = ctx.chat?.id;
	if (!ownerChatId) {
		throw new Error('Не удалось определить чат для прогресса');
	}
	if (!isUploadableSegmentPath(absolutePath)) {
		throw new Error('Можно загрузить только сегменты .mp4 (кроме source.mp4)');
	}

	const info = await stat(absolutePath);
	if (!info.isFile()) {
		throw new Error('Можно загружать только файлы');
	}

	const fileName = basename(absolutePath);
	const targetChatId = DEFAULT_TARGET_CHAT_ID ?? ownerChatId;
	const startedAtMs = Date.now();
	let uploadedBytes = 0;
	let currentState: SegmentUploadState = 'starting';
	let lastStatusText = '';
	let errorText: string | undefined;

	const statusMessage = await ctx.reply(
		buildUploadText({
			label: fileName,
			targetChatId,
			startedAtMs,
			totalBytes: info.size,
			uploadedBytes,
			state: currentState
		})
	);

	const pushStatus = async (): Promise<void> => {
		const text = buildUploadText({
			label: fileName,
			targetChatId,
			startedAtMs,
			totalBytes: info.size,
			uploadedBytes,
			state: currentState,
			errorText
		});
		if (text === lastStatusText) {
			return;
		}
		lastStatusText = text;
		try {
			await ctx.api.editMessageText(ownerChatId, statusMessage.message_id, text);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (!msg.includes('message is not modified')) {
				log.warn('Failed to edit segment upload status', { filePath: absolutePath, error: msg });
			}
		}
	};

	currentState = 'uploading';
	await pushStatus();

	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const metadata = await buildMetadataFromDirectory(parentPath);
	const files: UploadFileDescriptor[] = [{ path: absolutePath, sizeBytes: info.size }];

	try {
		await uploadVideoFiles(files, metadata, targetChatId, async progress => {
			uploadedBytes = progress.uploadedBytes;
			await pushStatus();
		});
		uploadedBytes = info.size;
		currentState = 'done';
		await pushStatus();
	} catch (error) {
		currentState = 'error';
		errorText = error instanceof Error ? error.message : String(error);
		await pushStatus();
		throw error;
	}
}

async function uploadDirectorySegmentsWithProgress(ctx: Context, absolutePath: string): Promise<void> {
	const ownerChatId = ctx.chat?.id;
	if (!ownerChatId) {
		throw new Error('Не удалось определить чат для прогресса');
	}

	const dirInfo = await stat(absolutePath);
	if (!dirInfo.isDirectory()) {
		throw new Error('Загрузка всех сегментов доступна только для папки');
	}

	const segments = await listUploadableSegmentsInDirectory(absolutePath);
	if (segments.length === 0) {
		throw new Error('В папке нет сегментов для загрузки');
	}

	const segmentsWithSize = await Promise.all(
		segments.map(async segment => ({
			...segment,
			sizeBytes: segment.sizeBytes ?? (await stat(segment.absolutePath)).size
		}))
	);

	const targetChatId = DEFAULT_TARGET_CHAT_ID ?? ownerChatId;
	const startedAtMs = Date.now();
	const totalBytes = segmentsWithSize.reduce((sum, item) => sum + item.sizeBytes, 0);
	const totalFiles = segmentsWithSize.length;
	let uploadedBytes = 0;
	let uploadedFiles = 0;
	let currentState: SegmentUploadState = 'starting';
	let lastStatusText = '';
	let errorText: string | undefined;
	let currentLabel = `${basename(absolutePath)} (${totalFiles} сегм.)`;

	const statusMessage = await ctx.reply(
		buildUploadText({
			label: currentLabel,
			targetChatId,
			startedAtMs,
			totalBytes,
			uploadedBytes,
			state: currentState,
			uploadedFiles,
			totalFiles
		})
	);

	const pushStatus = async (): Promise<void> => {
		const text = buildUploadText({
			label: currentLabel,
			targetChatId,
			startedAtMs,
			totalBytes,
			uploadedBytes,
			state: currentState,
			uploadedFiles,
			totalFiles,
			errorText
		});
		if (text === lastStatusText) {
			return;
		}
		lastStatusText = text;
		try {
			await ctx.api.editMessageText(ownerChatId, statusMessage.message_id, text);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (!msg.includes('message is not modified')) {
				log.warn('Failed to edit directory upload status', { dirPath: absolutePath, error: msg });
			}
		}
	};

	currentState = 'uploading';
	await pushStatus();

	const metadata = await buildMetadataFromDirectory(absolutePath);
	const files: UploadFileDescriptor[] = segmentsWithSize.map(item => ({
		path: item.absolutePath,
		sizeBytes: item.sizeBytes
	}));

	try {
		await uploadVideoFiles(files, metadata, targetChatId, async progress => {
			uploadedBytes = progress.uploadedBytes;
			uploadedFiles = progress.uploadedFiles;
			currentLabel = `${basename(absolutePath)} (${uploadedFiles}/${totalFiles})`;
			await pushStatus();
		});
	} catch (error) {
		currentState = 'error';
		errorText = error instanceof Error ? error.message : String(error);
		await pushStatus();
		throw error;
	}

	currentLabel = `${basename(absolutePath)} (${uploadedFiles}/${totalFiles})`;
	currentState = 'done';
	await pushStatus();
}

export function createStreamsCommand(): BotCommand {
	return {
		name: 'streams',
		description: 'Browse /data/streams',
		execute: async ctx => {
			const view = await buildDirectoryView(dataDir);
			await ctx.reply(view.text, { reply_markup: view.keyboard });
		}
	};
}

export function registerStreamsCallbacks(bot: Bot): void {
	bot.on('callback_query:data', async ctx => {
		const data = ctx.callbackQuery.data;
		if (!data.startsWith(callbackPrefix)) {
			return;
		}
		if (ctx.from?.id !== OWNER_USER_ID) {
			await ctx.answerCallbackQuery({ text: 'Доступ только владельцу' });
			return;
		}

		const payload = data.slice(callbackPrefix.length);
		const separator = payload.indexOf(':');
		if (separator === -1) {
			await ctx.answerCallbackQuery({ text: 'Некорректный callback' });
			return;
		}

		const action = payload.slice(0, separator);
		const token = payload.slice(separator + 1);
		if (!token) {
			await ctx.answerCallbackQuery({ text: 'Пустой callback token' });
			return;
		}

		try {
			const resolvedPath = getPathFromTokenOrNull(token);
			if (!resolvedPath) {
				const view = await buildDirectoryView(dataDir);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery({ text: 'Список устарел. Открыт корень.' });
				return;
			}

			if (action === 'open') {
				const view = await buildDirectoryView(resolvedPath);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery();
				return;
			}

			if (action === 'file') {
				const view = await buildFileView(resolvedPath);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery();
				return;
			}

			if (action === 'uploaddir') {
				await ctx.answerCallbackQuery({ text: 'Запускаю загрузку сегментов папки' });
				await uploadDirectorySegmentsWithProgress(ctx, resolvedPath);
				return;
			}

			if (action === 'uploadseg') {
				await ctx.answerCallbackQuery({ text: 'Запускаю загрузку сегмента' });
				await uploadSegmentWithProgress(ctx, resolvedPath);
				return;
			}

			if (action === 'delfile') {
				const parentPath = resolveSafePath(resolve(resolvedPath, '..'));
				await rm(resolvedPath, { force: true });
				const view = await buildDirectoryView(parentPath);
				await editBrowserMessage(
					ctx,
					`${view.text}\n\n✅ Файл удален: ${resolvedPath.split(/[\\/]/).at(-1) ?? resolvedPath}`,
					view.keyboard
				);
				await ctx.answerCallbackQuery({ text: 'Файл удален' });
				return;
			}

			if (action === 'deldir') {
				if (resolvedPath === dataDir) {
					await ctx.answerCallbackQuery({ text: 'Корневую папку удалять нельзя' });
					return;
				}
				const parentPath = resolveSafePath(resolve(resolvedPath, '..'));
				await rm(resolvedPath, { recursive: true, force: true });
				const view = await buildDirectoryView(parentPath);
				await editBrowserMessage(
					ctx,
					`${view.text}\n\n✅ Папка удалена: ${resolvedPath.split(/[\\/]/).at(-1) ?? resolvedPath}`,
					view.keyboard
				);
				await ctx.answerCallbackQuery({ text: 'Папка удалена' });
				return;
			}

			await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			try {
				await ctx.answerCallbackQuery({ text: text.slice(0, 180) });
			} catch {
				// Callback may already be answered.
			}
		}
	});
}