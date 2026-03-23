import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Context } from 'grammy';
import { DEFAULT_TARGET_CHAT_ID } from './config';
import { uploadVideoFiles } from './uploadTransport';
import type { UploadFileDescriptor } from './uploadTypes';
import {
	buildMetadataFromDirectory,
	formatBytes,
	isUploadableSegmentPath,
	listUploadableSegmentsInDirectory,
	log,
	resolveSafePath,
	type SegmentUploadState,
	type UploadStatus
} from './streamsShared';

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

async function createStatusPusher(
	ctx: Context,
	params: {
		logContext: Record<string, unknown>;
		logMessage: string;
		buildStatusText: () => string;
	}
): Promise<() => Promise<void>> {
	const ownerChatId = ctx.chat?.id;
	if (!ownerChatId) {
		throw new Error('Не удалось определить чат для прогресса');
	}

	const statusMessage = await ctx.reply(params.buildStatusText());
	let lastStatusText = '';

	return async () => {
		const text = params.buildStatusText();
		if (text === lastStatusText) {
			return;
		}
		lastStatusText = text;
		try {
			await ctx.api.editMessageText(ownerChatId, statusMessage.message_id, text);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes('message is not modified')) {
				log.warn(params.logMessage, { ...params.logContext, error: message });
			}
		}
	};
}

export async function uploadSegmentWithProgress(ctx: Context, absolutePath: string): Promise<void> {
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
	let errorText: string | undefined;

	const pushStatus = await createStatusPusher(ctx, {
		logContext: { filePath: absolutePath },
		logMessage: 'Failed to edit segment upload status',
		buildStatusText: () =>
			buildUploadText({
				label: fileName,
				targetChatId,
				startedAtMs,
				totalBytes: info.size,
				uploadedBytes,
				state: currentState,
				errorText
			})
	});

	currentState = 'uploading';
	await pushStatus();

	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const metadata = await buildMetadataFromDirectory(parentPath);
	const files: UploadFileDescriptor[] = [{ path: absolutePath, sizeBytes: info.size }];

	try {
		await uploadVideoFiles(files, metadata, targetChatId, async progress => {
			uploadedBytes = progress.uploadedBytes;
			await pushStatus();
		}, {
			finalPostChatId: ownerChatId
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

export async function uploadDirectorySegmentsWithProgress(
	ctx: Context,
	absolutePath: string
): Promise<void> {
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
	let errorText: string | undefined;
	let currentLabel = `${basename(absolutePath)} (${totalFiles} сегм.)`;

	const pushStatus = await createStatusPusher(ctx, {
		logContext: { dirPath: absolutePath },
		logMessage: 'Failed to edit directory upload status',
		buildStatusText: () =>
			buildUploadText({
				label: currentLabel,
				targetChatId,
				startedAtMs,
				totalBytes,
				uploadedBytes,
				state: currentState,
				uploadedFiles,
				totalFiles,
				errorText
			})
	});

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
		}, {
			finalPostChatId: ownerChatId
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

