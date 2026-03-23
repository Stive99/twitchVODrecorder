import { rename, rm, stat } from 'node:fs/promises';
import { updateUploadHistoryContext, updateUploadHistoryStatus } from './history';
import { logger } from './logger';
import {
	resolveTelegramEffectiveUploadLimitBytes,
	resolveUploadLimitDiagnostics
} from './uploadConfig';
import { ChunkTooLargeError } from './uploadErrors';
import { uploadChunks, uploadVideoFiles } from './uploadTransport';
import type { UploadProgress } from './uploadTypes';
import { VodJobMetrics } from './vodJobMetrics';
import { resolveInitialSlicePlan } from './vodJobPolicy';
import { downloadVodWithProgress } from './vodJobDownload';
import { loadVodMetadata, saveVodMetadataSnapshot } from './vodJobMetadata';
import { progressWithinStage, setStateAndNotify } from './vodJobStatus';
import {
	cleanupDelayMs,
	dataDir,
	resolveMaxAdaptiveSliceAttempts,
	resolveMinSegmentSeconds
} from './vodJobRuntime';
import {
	inspectGeneratedChunks,
	removeGeneratedChunks,
	resolveNextSegmentSeconds,
	sliceChunksWithProgress
} from './vodJobSlicing';
import type { SliceMode, VodJob } from './vodJobTypes';
import {
	buildChunkBaseName,
	formatBytes,
	formatUnknownError,
	parseDurationStringToSeconds,
	parseSourceId,
	sanitizeFileName,
	sleep
} from './vodJobUtils';

const log = logger.init('vod');
const telegramUploadLimitBytes = resolveTelegramEffectiveUploadLimitBytes();
const uploadLimitDiagnostics = resolveUploadLimitDiagnostics();
const directUploadLimitBytes = 2 * 1024 * 1024 * 1024;

async function setJobStage(job: VodJob, state: 'metadata' | 'downloading' | 'slicing' | 'uploading' | 'done'): Promise<void> {
	await setStateAndNotify(job, state);
	updateUploadHistoryStatus(job.id, state);
}

function resolveChunkPathContext(sourceId: string): { workDir: string; sourceFile: string } {
	const workDir = `${dataDir}/${sourceId}-${Date.now()}`;
	return {
		workDir,
		sourceFile: `${workDir}/source.mp4`
	};
}

function resolveDirectUploadFilePath(workDir: string, streamTitle: string): string {
	const safeName = sanitizeFileName(streamTitle) || 'stream';
	return `${workDir}/${safeName}.mp4`;
}

export async function processVod(job: VodJob): Promise<void> {
	const metrics = new VodJobMetrics(job.id);
	let success = false;
	let workDirForCleanup = '';
	try {
		const sourceId = parseSourceId(job.url);
		const resolvedPaths = resolveChunkPathContext(sourceId);
		const workDir = resolvedPaths.workDir;
		const sourceFile = resolvedPaths.sourceFile;
		let sourceFileForProcessing = sourceFile;
		workDirForCleanup = workDir;
		await Bun.$`mkdir -p ${workDir}`;
		updateUploadHistoryContext(job.id, { workDir });

		metrics.startStage('metadata');
		await setJobStage(job, 'metadata');
		const metadata = await loadVodMetadata(job.url);
		updateUploadHistoryContext(job.id, { streamTitle: metadata.streamTitle });
		await saveVodMetadataSnapshot(workDir, metadata);
		metrics.endStage('metadata');

		const chunkBaseName = buildChunkBaseName(metadata.streamTitle, sourceId);
		const chunksPattern = `${workDir}/${chunkBaseName}_%03d.mp4`;

		metrics.startStage('downloading');
		await setJobStage(job, 'downloading');
		await downloadVodWithProgress(job, sourceFile);
		metrics.endStage('downloading');

		const sourceStat = await stat(sourceFileForProcessing);
		log.info('Source file prepared for Telegram publish', {
			jobId: job.id,
			sourceFilePath: sourceFileForProcessing,
			sourceFileBytes: sourceStat.size,
			directUploadLimitBytes,
			effectiveChunkLimitBytes: telegramUploadLimitBytes,
			uploadLimitDiagnostics
		});
		if (sourceStat.size <= directUploadLimitBytes) {
			const directUploadFile = resolveDirectUploadFilePath(
				workDir,
				metadata.streamTitle
			);
			if (directUploadFile !== sourceFileForProcessing) {
				await rename(sourceFileForProcessing, directUploadFile);
				sourceFileForProcessing = directUploadFile;
			}

			metrics.startStage('uploading');
			await setJobStage(job, 'uploading');
			try {
				await uploadVideoFiles(
					[{ path: directUploadFile, sizeBytes: sourceStat.size }],
					metadata,
					job.targetChatId,
					async (progress: UploadProgress) => {
						const ratio =
							progress.totalBytes > 0
								? progress.uploadedBytes / progress.totalBytes
								: 0;
						const percent = progressWithinStage('uploading', ratio);
						await setStateAndNotify(job, 'uploading', undefined, percent);
					},
					{
						finalPostChatId: job.requestedByChatId,
						telemetry: {
							onEntityTooLarge: () => {
								metrics.recordEntityTooLarge();
							}
						}
					}
				);
				metrics.endStage('uploading');
				job.publishSummary = `1 file, total ${formatBytes(sourceStat.size)}, direct upload`;
				log.info('Direct upload completed without slicing', {
					jobId: job.id,
					filePath: directUploadFile,
					fileSizeBytes: sourceStat.size
				});

				await sleep(cleanupDelayMs);
				await rm(workDir, { recursive: true, force: true });
				log.info('Work directory removed after successful upload', {
					jobId: job.id,
					workDir,
					cleanupDelayMs
				});
				await setJobStage(job, 'done');
				await setStateAndNotify(job, 'done', undefined, 100);
				success = true;
				return;
			} catch (error) {
				metrics.endStage('uploading');
				if (!(error instanceof ChunkTooLargeError)) {
					throw error;
				}
				if (directUploadFile !== sourceFile && sourceFileForProcessing === directUploadFile) {
					try {
						await rename(directUploadFile, sourceFile);
						sourceFileForProcessing = sourceFile;
					} catch (renameBackError) {
						log.warn('Failed to rename direct-upload file back to source before slicing fallback', {
							jobId: job.id,
							from: directUploadFile,
							to: sourceFile,
							error: formatUnknownError(renameBackError)
						});
					}
				}
				metrics.recordEntityTooLarge();
				log.warn('Direct upload rejected as too large, falling back to slicing', {
					jobId: job.id,
					filePath: directUploadFile,
					fileSizeBytes: sourceStat.size
				});
			}
		}

		const durationSeconds = parseDurationStringToSeconds(metadata.durationText);
		const initialSlicePlan = await resolveInitialSlicePlan(
			sourceFileForProcessing,
			sourceStat.size,
			durationSeconds,
			telegramUploadLimitBytes
		);
		let effectiveSegmentSeconds = initialSlicePlan.effectiveSegmentSeconds;
		let sliceMode: SliceMode = 'copy';
		let uploadCompleted = false;
		const minAllowedSegmentSeconds = resolveMinSegmentSeconds();
		const maxAttempts = resolveMaxAdaptiveSliceAttempts();
		log.info('Initial slice plan resolved', {
			jobId: job.id,
			baseBySizeSegmentSeconds: initialSlicePlan.baseBySizeSegmentSeconds,
			effectiveSegmentSeconds,
			probeBytesPerSecond: initialSlicePlan.probeBytesPerSecond
		});

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			await removeGeneratedChunks(workDir, chunkBaseName);

			metrics.startStage('slicing');
			await setJobStage(job, 'slicing');
			await setStateAndNotify(
				job,
				'slicing',
				undefined,
				progressWithinStage('slicing', (attempt - 1) / maxAttempts)
			);
			try {
				await sliceChunksWithProgress(
					sourceFileForProcessing,
					chunksPattern,
					effectiveSegmentSeconds,
					sliceMode,
					durationSeconds,
					async ratio => {
						const combinedRatio = ((attempt - 1) + ratio) / maxAttempts;
						await setStateAndNotify(
							job,
							'slicing',
							undefined,
							progressWithinStage('slicing', combinedRatio)
						);
					}
				);
			} catch (error) {
				metrics.endStage('slicing');
				if (sliceMode === 'copy') {
					metrics.recordSliceRetry();
					log.warn('Copy slicing failed, retrying with re-encode mode', {
						jobId: job.id,
						attempt,
						effectiveSegmentSeconds,
						error: formatUnknownError(error)
					});
					sliceMode = 'reencode';
					continue;
				}
				throw error;
			}
			await setStateAndNotify(
				job,
				'slicing',
				undefined,
				progressWithinStage('slicing', attempt / maxAttempts)
			);
			metrics.endStage('slicing');

			const chunkInspection = await inspectGeneratedChunks(
				workDir,
				chunkBaseName,
				telegramUploadLimitBytes
			);
			metrics.recordChunkStats(chunkInspection.count, chunkInspection.totalSizeBytes);
			log.info('Chunk inspection after slicing', {
				jobId: job.id,
				attempt,
				sliceMode,
				effectiveSegmentSeconds,
				chunkCount: chunkInspection.count,
				totalChunkBytes: chunkInspection.totalSizeBytes,
				largestChunkPath: chunkInspection.largestPath,
				largestChunkBytes: chunkInspection.largestSizeBytes,
				largestVsLimitRatio:
					telegramUploadLimitBytes > 0
						? Number((chunkInspection.largestSizeBytes / telegramUploadLimitBytes).toFixed(3))
						: undefined,
				uploadLimitDiagnostics
			});
			if (chunkInspection.oversizedPath) {
				metrics.recordEntityTooLarge();
				if (sliceMode === 'copy') {
					metrics.recordSliceRetry();
					log.warn('Copy slicing produced oversized chunk, retrying with re-encode mode', {
						jobId: job.id,
						attempt,
						effectiveSegmentSeconds,
						chunkFilePath: chunkInspection.oversizedPath,
						overSizedChunkBytes: chunkInspection.oversizedSizeBytes
					});
					sliceMode = 'reencode';
					continue;
				}

				if (attempt >= maxAttempts || effectiveSegmentSeconds <= minAllowedSegmentSeconds) {
					throw new ChunkTooLargeError(
						chunkInspection.oversizedPath,
						chunkInspection.oversizedSizeBytes
					);
				}

				const nextSegmentSeconds = resolveNextSegmentSeconds(
					effectiveSegmentSeconds,
					telegramUploadLimitBytes,
					chunkInspection.oversizedSizeBytes
				);
				if (nextSegmentSeconds >= effectiveSegmentSeconds) {
					throw new ChunkTooLargeError(
						chunkInspection.oversizedPath,
						chunkInspection.oversizedSizeBytes
					);
				}

				metrics.recordSliceRetry();
				log.warn('Chunk too large after slicing, retrying with smaller segment size', {
					jobId: job.id,
					attempt,
					sliceMode,
					currentSegmentSeconds: effectiveSegmentSeconds,
					nextSegmentSeconds,
					chunkFilePath: chunkInspection.oversizedPath,
					overSizedChunkBytes: chunkInspection.oversizedSizeBytes
				});
				effectiveSegmentSeconds = nextSegmentSeconds;
				continue;
			}

			metrics.startStage('uploading');
			await setJobStage(job, 'uploading');
			log.info('Starting Telegram publish attempt', {
				jobId: job.id,
				attempt,
				maxAttempts,
				sliceMode,
				effectiveSegmentSeconds,
				targetChatId: job.targetChatId,
				workDir,
				chunkBaseName
			});
			try {
				let lastUploadProgress: UploadProgress | undefined;
				await uploadChunks(
					workDir,
					metadata,
					job.targetChatId,
					chunkBaseName,
					async (progress: UploadProgress) => {
						lastUploadProgress = progress;
						const ratio = progress.totalBytes > 0 ? progress.uploadedBytes / progress.totalBytes : 0;
						const percent = progressWithinStage('uploading', ratio);
						await setStateAndNotify(job, 'uploading', undefined, percent);
					},
					{
						finalPostChatId: job.requestedByChatId,
						telemetry: {
							onRetry: () => {
								metrics.recordUploadRetry();
							},
							onEntityTooLarge: () => {
								metrics.recordEntityTooLarge();
							}
						}
					}
				);
				uploadCompleted = true;
				const totalUploadedBytes = lastUploadProgress?.totalBytes ?? sourceStat.size;
				job.publishSummary = [
					`${chunkInspection.count} files`,
					`total ${formatBytes(totalUploadedBytes)}`,
					`attempt ${attempt}/${maxAttempts}`,
					`mode ${sliceMode}`,
					`segment ${effectiveSegmentSeconds}s`
				].join(', ');
				log.info('Telegram publish attempt succeeded', {
					jobId: job.id,
					attempt,
					sliceMode,
					effectiveSegmentSeconds
				});
				metrics.endStage('uploading');
				break;
			} catch (error) {
				metrics.endStage('uploading');
				log.warn('Telegram publish attempt failed', {
					jobId: job.id,
					attempt,
					sliceMode,
					effectiveSegmentSeconds,
					error: formatUnknownError(error)
				});
				if (!(error instanceof ChunkTooLargeError)) {
					throw error;
				}
				metrics.recordEntityTooLarge();

				if (sliceMode === 'copy') {
					metrics.recordSliceRetry();
					log.warn('Upload rejected copy-sliced chunk, retrying with re-encode mode', {
						jobId: job.id,
						attempt,
						effectiveSegmentSeconds,
						chunkFilePath: error.filePath
					});
					sliceMode = 'reencode';
					continue;
				}

				if (attempt >= maxAttempts || effectiveSegmentSeconds <= minAllowedSegmentSeconds) {
					throw error;
				}

				let overSizedChunkBytes = error.sizeBytes;
				if (!overSizedChunkBytes) {
					try {
						const info = await stat(error.filePath);
						overSizedChunkBytes = info.size;
					} catch {
						overSizedChunkBytes = undefined;
					}
				}

				const nextSegmentSeconds = resolveNextSegmentSeconds(
					effectiveSegmentSeconds,
					telegramUploadLimitBytes,
					overSizedChunkBytes
				);
				if (nextSegmentSeconds >= effectiveSegmentSeconds) {
					throw error;
				}

				metrics.recordSliceRetry();
				log.warn('Chunk too large, retrying with smaller segment size', {
					jobId: job.id,
					attempt,
					sliceMode,
					currentSegmentSeconds: effectiveSegmentSeconds,
					nextSegmentSeconds,
					chunkFilePath: error.filePath,
					overSizedChunkBytes
				});
				effectiveSegmentSeconds = nextSegmentSeconds;
			}
		}
		if (!uploadCompleted) {
			throw new Error(`Telegram publish did not complete for job ${job.id} after ${maxAttempts} attempts`);
		}
		await sleep(cleanupDelayMs);
		await rm(workDir, { recursive: true, force: true });
		log.info('Work directory removed after successful upload', {
			jobId: job.id,
			workDir,
			cleanupDelayMs
		});

		await setJobStage(job, 'done');
		await setStateAndNotify(job, 'done', undefined, 100);
		success = true;
	} finally {
		if (!success && workDirForCleanup) {
			try {
				await rm(workDirForCleanup, { recursive: true, force: true });
				log.info('Work directory removed after failed upload', {
					jobId: job.id,
					workDir: workDirForCleanup
				});
			} catch (cleanupError) {
				log.warn('Failed to remove work directory after failed upload', {
					jobId: job.id,
					workDir: workDirForCleanup,
					error: formatUnknownError(cleanupError)
				});
			}
		}
		metrics.finalize(success);
	}
}

