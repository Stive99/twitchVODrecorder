import { stat } from 'node:fs/promises';
import { GrammyError, HttpError, InputFile, InputMediaBuilder } from 'grammy';
import { bot } from './config';
import { logger } from './logger';

const log = logger.init('upload');

export interface UploadMetadata {
	streamTitle: string;
	streamDate?: string;
	channel: string;
	channelUrl?: string;
	durationText: string;
	titles: Array<{ title: string; category: string }>;
	vodUrl: string;
}

export interface UploadProgress {
	uploadedBytes: number;
	totalBytes: number;
	uploadedFiles: number;
	totalFiles: number;
}

export interface UploadFileDescriptor {
	path: string;
	sizeBytes: number;
}

export class ChunkTooLargeError extends Error {
	filePath: string;
	sizeBytes?: number;

	constructor(filePath: string, sizeBytes?: number, options?: ErrorOptions) {
		super(
			`Chunk is too large for Telegram upload: ${filePath}. Reduce segment duration and retry.`,
			options
		);
		this.name = 'ChunkTooLargeError';
		this.filePath = filePath;
		this.sizeBytes = sizeBytes;
	}
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function validateUploadMetadata(meta: UploadMetadata): void {
	if (!meta.streamTitle?.trim()) {
		throw new Error('Upload metadata streamTitle is empty');
	}
	if (!meta.channel?.trim()) {
		throw new Error('Upload metadata channel is empty');
	}
	if (!meta.durationText?.trim()) {
		throw new Error('Upload metadata durationText is empty');
	}
	if (!meta.vodUrl?.trim()) {
		throw new Error('Upload metadata vodUrl is empty');
	}
	if (!Array.isArray(meta.titles) || meta.titles.length === 0) {
		throw new Error('Upload metadata titles are empty');
	}
}

function normalizeTargetChatId(targetChatId: string | number): string | number {
	if (typeof targetChatId === 'number') {
		if (!Number.isFinite(targetChatId)) {
			throw new Error('Target chat id is not finite');
		}
		return targetChatId;
	}
	const normalized = targetChatId.trim();
	if (!normalized) {
		throw new Error('Target chat id is empty');
	}
	return normalized;
}

interface NormalizedUploadFile {
	path: string;
	sizeBytes: number;
}

async function prepareUploadFiles(
	filesInput: UploadFileDescriptor[],
	maxUploadBytes: number
): Promise<{ files: NormalizedUploadFile[]; totalBytes: number }> {
	const seenPaths = new Set<string>();
	const files: NormalizedUploadFile[] = [];
	let totalBytes = 0;

	for (const file of filesInput) {
		const filePath = file.path?.trim();
		if (!filePath) {
			throw new Error('Upload file path is empty');
		}
		if (seenPaths.has(filePath)) {
			throw new Error(`Duplicate upload file path: ${filePath}`);
		}
		seenPaths.add(filePath);

		let info;
		try {
			info = await stat(filePath);
		} catch (error) {
			throw new Error(`Upload file is not accessible: ${filePath} (${formatUnknownError(error)})`, { cause: error });
		}
		if (!info.isFile()) {
			throw new Error(`Upload path is not a file: ${filePath}`);
		}
		if (info.size <= 0) {
			throw new Error(`Upload file is empty: ${filePath}`);
		}

		if (file.sizeBytes !== info.size) {
			log.warn('Upload descriptor size differs from actual file size, actual size will be used', {
				filePath,
				descriptorSizeBytes: file.sizeBytes,
				actualSizeBytes: info.size
			});
		}
		if (info.size > maxUploadBytes) {
			throw new ChunkTooLargeError(filePath, info.size);
		}

		files.push({ path: filePath, sizeBytes: info.size });
		totalBytes += info.size;
	}

	return { files, totalBytes };
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function buildUploadCaption(meta: UploadMetadata): string {
	const lines: string[] = [];

	const safeChannel = escapeHtml(meta.channel);
	const channelHeader = meta.channelUrl
		? `<a href="${escapeHtml(meta.channelUrl)}"><b>${safeChannel}</b></a>`
		: `<b>${safeChannel}</b>`;
	lines.push(`📺 ${channelHeader}`);
	lines.push(`⏱ Длительность: ${escapeHtml(meta.durationText)}`);
	lines.push('');

	if (meta.streamDate) {
		lines.push(`📅 Дата стрима: ${escapeHtml(meta.streamDate)}`);
		lines.push('');
	}

	lines.push('🎮 Названия:');
	meta.titles.forEach((item, index) => {
		lines.push(`${index + 1}. ${escapeHtml(item.title)}`);
		lines.push(`🗂 Категория: ${escapeHtml(item.category)}`);
	});

	const base = lines.join('\n');
	return base.length <= 1000 ? base : `${base.slice(0, 997)}...`;
}

function isRequestEntityTooLarge(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return text.includes('413') || text.includes('Request Entity Too Large');
}

const TELEGRAM_UPLOAD_LIMIT_MB = 1900;

export function resolveTelegramUploadLimitBytes(): number {
	return Math.floor(TELEGRAM_UPLOAD_LIMIT_MB * 1024 * 1024);
}

const uploadRetryAttempts = 4;
const uploadRetryBaseDelayMs = 1500;
const uploadRetryMaxDelayMs = 30000;
const uploadHeartbeatIntervalMs = 2000;
const uploadHeartbeatWindowMs = 45000;
const useMediaGroupUpload = true;
const mediaGroupMaxSize = 10;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(error: GrammyError): number | undefined {
	const retryAfter = (error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
	if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
		return undefined;
	}
	return Math.floor(retryAfter);
}

function isTransientUploadError(error: unknown): boolean {
	if (error instanceof HttpError) {
		return true;
	}
	const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		text.includes('etimedout') ||
		text.includes('econnreset') ||
		text.includes('econnrefused') ||
		text.includes('eai_again') ||
		text.includes('network') ||
		text.includes('timeout')
	);
}

function resolveRetryDelayMs(error: unknown, attempt: number): number | undefined {
	if (attempt >= uploadRetryAttempts) {
		return undefined;
	}

	if (error instanceof GrammyError && error.error_code === 429) {
		const retryAfterSeconds = parseRetryAfterSeconds(error) ?? 2;
		return Math.min(uploadRetryMaxDelayMs, Math.max(uploadRetryBaseDelayMs, retryAfterSeconds * 1000));
	}

	if (isTransientUploadError(error)) {
		return Math.min(uploadRetryMaxDelayMs, uploadRetryBaseDelayMs * 2 ** (attempt - 1));
	}

	return undefined;
}

export async function uploadVideoFiles(
	filesInput: UploadFileDescriptor[],
	meta: UploadMetadata,
	targetChatId: string | number,
	onProgress?: (progress: UploadProgress) => Promise<void> | void
): Promise<void> {
	if (filesInput.length === 0) {
		throw new Error('No files were provided for upload');
	}
	validateUploadMetadata(meta);
	const normalizedTargetChatId = normalizeTargetChatId(targetChatId);

	const maxUploadBytes = resolveTelegramUploadLimitBytes();
	const { files, totalBytes } = await prepareUploadFiles(filesInput, maxUploadBytes);
	const sessionId = `upl-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
	const startedAtMs = Date.now();
	log.info('Starting Telegram upload session', {
		sessionId,
		targetChatId: normalizedTargetChatId,
		fileCount: files.length,
		totalBytes,
		maxUploadBytes,
		useMediaGroupUpload,
		mediaGroupMaxSize
	});

	const emitProgress = async (progress: UploadProgress): Promise<void> => {
		if (!onProgress) {
			return;
		}
		await onProgress(progress);
	};

	const caption = buildUploadCaption(meta);
	let uploadedBytes = 0;
	let uploadedFiles = 0;
	await emitProgress({
		uploadedBytes,
		totalBytes,
		uploadedFiles,
		totalFiles: files.length
	});

	const sendSingleFile = async (
		file: { path: string; sizeBytes: number },
		index: number
	): Promise<void> => {
		const filePath = file.path;
		log.info('Sending file to Telegram', {
			sessionId,
			filePath,
			fileSizeBytes: file.sizeBytes,
			fileIndex: index + 1,
			totalFiles: files.length
		});
		const media = InputMediaBuilder.video(
			new InputFile(filePath),
			index === 0
				? { caption, parse_mode: 'HTML', supports_streaming: true }
				: { supports_streaming: true }
		);
		for (let attempt = 1; ; attempt += 1) {
			const sendStartedAt = Date.now();
			const startBytes = uploadedBytes;
			const startFiles = uploadedFiles;
			const timer = onProgress
				? setInterval(() => {
					const elapsed = Date.now() - sendStartedAt;
					const ratio = Math.min(0.95, elapsed / uploadHeartbeatWindowMs);
					const optimisticBytes = Math.min(
						startBytes + file.sizeBytes - 1,
						startBytes + Math.floor(file.sizeBytes * ratio)
					);
					if (optimisticBytes <= uploadedBytes) {
						return;
					}
					const progressPromise = emitProgress({
						uploadedBytes: optimisticBytes,
						totalBytes,
						uploadedFiles: startFiles,
						totalFiles: files.length
					});
					progressPromise.catch(progressError => {
						log.warn('Failed to emit upload heartbeat progress', {
							filePath,
							error: progressError instanceof Error ? progressError.message : String(progressError)
						});
					});
				}, uploadHeartbeatIntervalMs)
				: undefined;
			try {
				await bot.api.sendVideo(normalizedTargetChatId, media.media, media);
				if (timer) {
					clearInterval(timer);
				}
				uploadedBytes += file.sizeBytes;
				uploadedFiles += 1;
				await emitProgress({
					uploadedBytes,
					totalBytes,
					uploadedFiles,
					totalFiles: files.length
				});
				log.info('File uploaded successfully', {
					sessionId,
					filePath,
					fileIndex: index + 1,
					totalFiles: files.length,
					attempt
				});
				break;
			} catch (error) {
				if (timer) {
					clearInterval(timer);
				}
				if (isRequestEntityTooLarge(error)) {
					log.error('Telegram rejected file upload with entity too large', {
						sessionId,
						filePath,
						fileSizeBytes: file.sizeBytes,
						error: formatUnknownError(error)
					});
					throw new ChunkTooLargeError(filePath, undefined, { cause: error });
				}
				const retryDelayMs = resolveRetryDelayMs(error, attempt);
				if (!retryDelayMs) {
					log.error('File upload failed without retry', {
						sessionId,
						filePath,
						attempt,
						error: formatUnknownError(error)
					});
					throw error;
				}
				log.warn('Retrying Telegram upload after transient API error', {
					sessionId,
					filePath,
					attempt,
					retryDelayMs,
					error: error instanceof Error ? error.message : String(error)
				});
				await sleep(retryDelayMs);
			}
		}
	};

	if (!useMediaGroupUpload) {
		for (const [index, file] of files.entries()) {
			await sendSingleFile(file, index);
		}
		return;
	}

	for (let batchStart = 0; batchStart < files.length; batchStart += mediaGroupMaxSize) {
		const batch = files.slice(batchStart, batchStart + mediaGroupMaxSize);
		const batchBytes = batch.reduce((sum, file) => sum + file.sizeBytes, 0);
		const batchEnd = batchStart + batch.length - 1;
		let fallbackToSingleUpload = false;
		let batchSent = false;
		log.info('Sending media-group batch', {
			sessionId,
			batchStart,
			batchEnd,
			batchSize: batch.length,
			batchBytes
		});

		for (let attempt = 1; ; attempt += 1) {
			const sendStartedAt = Date.now();
			const startBytes = uploadedBytes;
			const startFiles = uploadedFiles;
			const timer = onProgress
				? setInterval(() => {
					const elapsed = Date.now() - sendStartedAt;
					const ratio = Math.min(0.95, elapsed / uploadHeartbeatWindowMs);
					const optimisticBytes = Math.min(
						startBytes + batchBytes - 1,
						startBytes + Math.floor(batchBytes * ratio)
					);
					if (optimisticBytes <= uploadedBytes) {
						return;
					}
					const optimisticFiles = Math.min(
						startFiles + batch.length - 1,
						startFiles + Math.floor(batch.length * ratio)
					);
					const progressPromise = emitProgress({
						uploadedBytes: optimisticBytes,
						totalBytes,
						uploadedFiles: optimisticFiles,
						totalFiles: files.length
					});
					progressPromise.catch(progressError => {
						log.warn('Failed to emit media-group heartbeat progress', {
							batchStart,
							error:
								progressError instanceof Error
									? progressError.message
									: String(progressError)
						});
					});
				}, uploadHeartbeatIntervalMs)
				: undefined;
			try {
				const media = batch.map((file, indexInBatch) => ({
					type: 'video' as const,
					media: new InputFile(file.path),
					supports_streaming: true,
					...(batchStart === 0 && indexInBatch === 0
						? { caption, parse_mode: 'HTML' as const }
						: {})
				}));
				await bot.api.sendMediaGroup(normalizedTargetChatId, media);
				if (timer) {
					clearInterval(timer);
				}
				uploadedBytes += batchBytes;
				uploadedFiles += batch.length;
				await emitProgress({
					uploadedBytes,
					totalBytes,
					uploadedFiles,
					totalFiles: files.length
				});
				log.info('Media-group batch uploaded successfully', {
					sessionId,
					batchStart,
					batchEnd,
					attempt
				});
				batchSent = true;
				break;
			} catch (error) {
				if (timer) {
					clearInterval(timer);
				}
				if (isRequestEntityTooLarge(error)) {
					log.warn('Media-group batch rejected as too large, will fallback to single-file mode', {
						sessionId,
						batchStart,
						batchEnd,
						error: formatUnknownError(error)
					});
					fallbackToSingleUpload = true;
					break;
				}
				const retryDelayMs = resolveRetryDelayMs(error, attempt);
				if (!retryDelayMs) {
					log.error('Media-group batch upload failed without retry', {
						sessionId,
						batchStart,
						batchEnd,
						attempt,
						error: formatUnknownError(error)
					});
					throw error;
				}
				log.warn('Retrying media-group upload after transient API error', {
					sessionId,
					batchStart,
					attempt,
					retryDelayMs,
					error: error instanceof Error ? error.message : String(error)
				});
				await sleep(retryDelayMs);
			}
		}

		if (batchSent) {
			continue;
		}
		if (!fallbackToSingleUpload) {
			throw new Error(`Media-group upload failed for batch starting at index ${batchStart}`);
		}
		log.warn('Media-group chunk upload is too large, falling back to single-file sends', {
			sessionId,
			batchStart,
			batchSize: batch.length
		});
		for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch += 1) {
			const file = batch[indexInBatch];
			if (!file) {
				continue;
			}
			const fileIndex = batchStart + indexInBatch;
			await sendSingleFile(file, fileIndex);
		}
	}

	const elapsedMs = Date.now() - startedAtMs;
	log.info('Telegram upload session completed', {
		sessionId,
		targetChatId: normalizedTargetChatId,
		fileCount: files.length,
		totalBytes,
		elapsedMs
	});
}

export async function uploadChunks(
	dir: string,
	meta: UploadMetadata,
	targetChatId: string | number,
	chunkBaseName: string,
	onProgress?: (progress: UploadProgress) => Promise<void> | void
): Promise<void> {
	const files: UploadFileDescriptor[] = [];
	for await (const name of new Bun.Glob(`${chunkBaseName}_*.mp4`).scan({
		cwd: dir
	})) {
		const path = `${dir}/${name}`;
		const info = await stat(path);
		files.push({ path, sizeBytes: info.size });
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	if (files.length === 0) {
		throw new Error(`No chunk files found for upload in ${dir} by pattern ${chunkBaseName}_*.mp4`);
	}
	log.info('Prepared chunk list for Telegram upload', {
		dir,
		chunkBaseName,
		fileCount: files.length,
		totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0)
	});
	await uploadVideoFiles(files, meta, targetChatId, onProgress);
}