import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'bun';
import { logger } from './logger';
import { formatUnknownError } from './uploadErrors';

const log = logger.init('upload-video');

interface FfprobeStream {
	codec_type?: string;
	width?: number;
	height?: number;
	duration?: string;
}

interface FfprobeFormat {
	duration?: string;
}

interface FfprobeResult {
	streams?: FfprobeStream[];
	format?: FfprobeFormat;
}

export interface PreparedTelegramVideoFile {
	path: string;
	sizeBytes: number;
	durationSeconds?: number;
	width?: number;
	height?: number;
	thumbnailPath?: string;
	cleanup: () => Promise<void>;
}

function normalizePositiveInt(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.floor(value);
}

function parseDurationSeconds(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.max(1, Math.round(parsed));
}

async function probeVideoFile(
	filePath: string
): Promise<Pick<PreparedTelegramVideoFile, 'durationSeconds' | 'width' | 'height'>> {
	try {
		const proc = spawn(
			[
				'ffprobe',
				'-v',
				'error',
				'-show_entries',
				'format=duration:stream=codec_type,width,height,duration',
				'-of',
				'json',
				filePath
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);
		if (exitCode !== 0) {
			log.warn('ffprobe failed while preparing upload video', {
				filePath,
				exitCode,
				stderr: stderr.trim().slice(-1000)
			});
			return {};
		}

		const parsed = JSON.parse(stdout) as FfprobeResult;
		const videoStream = parsed.streams?.find(stream => stream.codec_type === 'video');
		return {
			durationSeconds:
				parseDurationSeconds(parsed.format?.duration) ??
				parseDurationSeconds(videoStream?.duration),
			width: normalizePositiveInt(videoStream?.width),
			height: normalizePositiveInt(videoStream?.height)
		};
	} catch (error) {
		log.warn('Failed to probe upload video', {
			filePath,
			error: formatUnknownError(error)
		});
		return {};
	}
}

function resolveThumbnailSeekSeconds(durationSeconds?: number): string {
	if (!durationSeconds || durationSeconds <= 2) {
		return '0';
	}
	const candidate = Math.floor(durationSeconds * 0.05);
	return String(Math.max(1, Math.min(10, candidate)));
}

async function generateThumbnail(
	filePath: string,
	durationSeconds?: number
): Promise<{ thumbnailPath?: string; cleanup: () => Promise<void> }> {
	let tempDir = '';
	try {
		tempDir = await mkdtemp(join(tmpdir(), 'tvr-thumb-'));
		const thumbnailPath = join(tempDir, 'thumb.jpg');
		const proc = spawn(
			[
				'ffmpeg',
				'-y',
				'-ss',
				resolveThumbnailSeekSeconds(durationSeconds),
				'-i',
				filePath,
				'-frames:v',
				'1',
				'-an',
				'-vf',
				'thumbnail,scale=320:320:force_original_aspect_ratio=decrease',
				'-q:v',
				'6',
				thumbnailPath
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);
		if (exitCode !== 0) {
			log.warn('ffmpeg thumbnail generation failed', {
				filePath,
				exitCode,
				output: (stderr || stdout).trim().slice(-1000)
			});
			await rm(tempDir, { recursive: true, force: true });
			return { cleanup: async () => undefined };
		}

		const info = await stat(thumbnailPath);
		if (info.size <= 0) {
			await rm(tempDir, { recursive: true, force: true });
			return { cleanup: async () => undefined };
		}

		return {
			thumbnailPath,
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true });
			}
		};
	} catch (error) {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
		log.warn('Failed to generate upload thumbnail', {
			filePath,
			error: formatUnknownError(error)
		});
		return { cleanup: async () => undefined };
	}
}

export async function prepareTelegramVideoFile(
	filePath: string,
	sizeBytes: number
): Promise<PreparedTelegramVideoFile> {
	const probed = await probeVideoFile(filePath);
	const thumbnail = await generateThumbnail(filePath, probed.durationSeconds);

	return {
		path: filePath,
		sizeBytes,
		durationSeconds: probed.durationSeconds,
		width: probed.width,
		height: probed.height,
		thumbnailPath: thumbnail.thumbnailPath,
		cleanup: thumbnail.cleanup
	};
}