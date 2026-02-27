import { readFile, stat, writeFile } from 'node:fs/promises';
import { GrammyError, HttpError, InputFile, InputMediaBuilder } from 'grammy';
import { bot } from './config';
import { logger } from './logger';
import {
	mediaGroupMaxSize,
	postRetryAttempts,
	postSendDelayMs,
	resolveTelegramEffectiveUploadLimitBytes,
	resolveUploadLimitDiagnostics,
	sendFinalPostAfterUpload,
	sleep,
	uploadHeartbeatIntervalMs,
	uploadHeartbeatWindowMs,
	uploadRetryAttempts,
	uploadRetryBaseDelayMs,
	uploadRetryMaxDelayMs,
	useMediaGroupUpload
} from './uploadConfig';
import { ChunkTooLargeError, formatUnknownError, isRequestEntityTooLarge } from './uploadErrors';
import { buildFinalPostText, buildUploadCaption } from './uploadFormatting';
import { normalizeTargetChatId, prepareUploadFiles, validateUploadMetadata } from './uploadValidation';
import type {
	NormalizedUploadFile,
	UploadFileDescriptor,
	UploadMetadata,
	UploadProgress,
	UploadTelemetryHooks
} from './uploadTypes';

const log = logger.init('upload');

interface UploadCheckpointState {
	uploadedMessageIds: Record<string, number>;
	finalPostSent: boolean;
}

interface UploadSessionOptions {
	checkpointFilePath?: string;
	telemetry?: UploadTelemetryHooks;
}

function checkpointKey(path: string): string {
	return path;
}

function resolveMessageId(value: unknown, context: string): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	throw new Error(`Missing Telegram message_id for ${context}`);
}

async function loadCheckpointState(path?: string): Promise<UploadCheckpointState> {
	if (!path) {
		return { uploadedMessageIds: {}, finalPostSent: false };
	}
	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw) as Partial<UploadCheckpointState>;
		return {
			uploadedMessageIds:
				parsed.uploadedMessageIds && typeof parsed.uploadedMessageIds === 'object'
					? Object.fromEntries(
						Object.entries(parsed.uploadedMessageIds).filter(
							([k, v]) => typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)
						)
					)
					: {},
			finalPostSent: parsed.finalPostSent === true
		};
	} catch {
		return { uploadedMessageIds: {}, finalPostSent: false };
	}
}

async function saveCheckpointState(path: string | undefined, state: UploadCheckpointState): Promise<void> {
	if (!path) {
		return;
	}
	await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
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

async function sendFinalPost(
	targetChatId: string | number,
	postText: string,
	sessionId: string,
	telemetry?: UploadTelemetryHooks
): Promise<boolean> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			await bot.api.sendMessage(targetChatId, postText, {
				parse_mode: 'HTML',
				link_preview_options: { is_disabled: true }
			});
			log.info('Final post sent after upload', {
				sessionId,
				attempt
			});
			return true;
		} catch (error) {
			const retryDelayMs = resolveRetryDelayMs(error, attempt);
			if (!retryDelayMs || attempt >= postRetryAttempts) {
				log.warn('Failed to send final post after upload', {
					sessionId,
					attempt,
					error: formatUnknownError(error)
				});
				return false;
			}
			telemetry?.onRetry?.({ stage: 'post', attempt });
			log.warn('Retrying final post send after transient API error', {
				sessionId,
				attempt,
				retryDelayMs,
				error: error instanceof Error ? error.message : String(error)
			});
			await sleep(retryDelayMs);
		}
	}
}

export async function uploadVideoFiles(
	filesInput: UploadFileDescriptor[],
	meta: UploadMetadata,
	targetChatId: string | number,
	onProgress?: (progress: UploadProgress) => Promise<void> | void,
	options?: UploadSessionOptions
): Promise<void> {
	if (filesInput.length === 0) {
		throw new Error('No files were provided for upload');
	}
	validateUploadMetadata(meta);
	const normalizedTargetChatId = normalizeTargetChatId(targetChatId);

	const maxUploadBytes = resolveTelegramEffectiveUploadLimitBytes();
	const uploadLimitDiagnostics = resolveUploadLimitDiagnostics();
	const { files, totalBytes } = await prepareUploadFiles(filesInput, maxUploadBytes);
	const checkpointState = await loadCheckpointState(options?.checkpointFilePath);
	const sessionId = `upl-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
	const startedAtMs = Date.now();
	log.info('Starting Telegram upload session', {
		sessionId,
		targetChatId: normalizedTargetChatId,
		fileCount: files.length,
		totalBytes,
		maxUploadBytes,
		uploadLimitDiagnostics,
		useMediaGroupUpload,
		mediaGroupMaxSize,
		checkpointFilePath: options?.checkpointFilePath
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
	for (const file of files) {
		if (checkpointState.uploadedMessageIds[checkpointKey(file.path)]) {
			uploadedBytes += file.sizeBytes;
			uploadedFiles += 1;
		}
	}
	await emitProgress({
		uploadedBytes,
		totalBytes,
		uploadedFiles,
		totalFiles: files.length
	});

	const pendingEntries = files
		.map((file, index) => ({ file, index }))
		.filter(entry => {
			const done = Boolean(checkpointState.uploadedMessageIds[checkpointKey(entry.file.path)]);
			if (done) {
				log.info('Skipping already uploaded chunk based on checkpoint', {
					sessionId,
					filePath: entry.file.path,
					fileIndex: entry.index + 1
				});
			}
			return !done;
		});

	const markFileUploaded = async (filePath: string, messageId: number): Promise<void> => {
		checkpointState.uploadedMessageIds[checkpointKey(filePath)] = messageId;
		await saveCheckpointState(options?.checkpointFilePath, checkpointState);
	};

	const sendSingleFile = async (
		file: NormalizedUploadFile,
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
							error:
								progressError instanceof Error
									? progressError.message
									: String(progressError)
						});
					});
				}, uploadHeartbeatIntervalMs)
				: undefined;
			try {
				const message = await bot.api.sendVideo(normalizedTargetChatId, media.media, media);
				const messageId = resolveMessageId(message?.message_id, `sendVideo ${filePath}`);
				if (timer) {
					clearInterval(timer);
				}
				uploadedBytes += file.sizeBytes;
				uploadedFiles += 1;
				await markFileUploaded(filePath, messageId);
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
					attempt,
					messageId
				});
				break;
			} catch (error) {
				if (timer) {
					clearInterval(timer);
				}
				if (isRequestEntityTooLarge(error)) {
					options?.telemetry?.onEntityTooLarge?.({ stage: 'single' });
					log.error('Telegram rejected file upload with entity too large', {
						sessionId,
						filePath,
						fileSizeBytes: file.sizeBytes,
						configuredEffectiveLimitBytes: maxUploadBytes,
						fileWithinConfiguredLimit: file.sizeBytes <= maxUploadBytes,
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
				options?.telemetry?.onRetry?.({ stage: 'single', attempt });
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
		for (const entry of pendingEntries) {
			await sendSingleFile(entry.file, entry.index);
		}
	} else {
		for (let batchStart = 0; batchStart < pendingEntries.length; batchStart += mediaGroupMaxSize) {
			const batch = pendingEntries.slice(batchStart, batchStart + mediaGroupMaxSize);
			if (batch.length === 1) {
				const single = batch[0];
				if (single) {
					await sendSingleFile(single.file, single.index);
				}
				continue;
			}
			const batchBytes = batch.reduce((sum, entry) => sum + entry.file.sizeBytes, 0);
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
					const media = batch.map(entry => ({
						type: 'video' as const,
						media: new InputFile(entry.file.path),
						supports_streaming: true,
						...(entry.index === 0
							? { caption, parse_mode: 'HTML' as const }
							: {})
					}));
					const sentMessages = await bot.api.sendMediaGroup(normalizedTargetChatId, media);
					const messageIds = batch.map((entry, i) =>
						resolveMessageId(sentMessages[i]?.message_id, `sendMediaGroup ${entry.file.path}`)
					);
					if (timer) {
						clearInterval(timer);
					}
					for (let i = 0; i < batch.length; i += 1) {
						const entry = batch[i];
						if (!entry) {
							continue;
						}
						const messageId = messageIds[i];
						if (!messageId) {
							continue;
						}
						await markFileUploaded(entry.file.path, messageId);
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
						options?.telemetry?.onEntityTooLarge?.({ stage: 'group' });
						log.warn('Media-group batch rejected as too large, will fallback to single-file mode', {
							sessionId,
							batchStart,
							batchEnd,
							batchBytes,
							configuredEffectiveLimitBytes: maxUploadBytes,
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
					options?.telemetry?.onRetry?.({ stage: 'group', attempt });
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
			for (const entry of batch) {
				await sendSingleFile(entry.file, entry.index);
			}
		}
	}

	const elapsedMs = Date.now() - startedAtMs;
	if (sendFinalPostAfterUpload && !checkpointState.finalPostSent) {
		if (postSendDelayMs > 0) {
			log.info('Waiting before sending final post', {
				sessionId,
				postSendDelayMs
			});
			await sleep(postSendDelayMs);
		}
		const finalPostText = buildFinalPostText(meta, files.length, totalBytes);
		const sent = await sendFinalPost(normalizedTargetChatId, finalPostText, sessionId, options?.telemetry);
		if (sent) {
			checkpointState.finalPostSent = true;
			await saveCheckpointState(options?.checkpointFilePath, checkpointState);
		}
	}
	log.info('Telegram upload session completed', {
		sessionId,
		targetChatId: normalizedTargetChatId,
		fileCount: files.length,
		totalBytes,
		elapsedMs,
		resumedUploadedFiles: uploadedFiles,
		pendingFiles: pendingEntries.length
	});
}

export async function uploadChunks(
	dir: string,
	meta: UploadMetadata,
	targetChatId: string | number,
	chunkBaseName: string,
	onProgress?: (progress: UploadProgress) => Promise<void> | void,
	options?: UploadSessionOptions
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
	const mergedOptions: UploadSessionOptions = {
		checkpointFilePath: options?.checkpointFilePath ?? `${dir}/${chunkBaseName}.upload-state.json`,
		telemetry: options?.telemetry
	};
	await uploadVideoFiles(files, meta, targetChatId, onProgress, mergedOptions);
}