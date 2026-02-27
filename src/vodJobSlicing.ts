import { rm, stat } from 'node:fs/promises';
import { spawn } from 'bun';
import type { SliceMode } from './vodJobTypes';
import { formatUnknownError, trimOutput } from './vodJobUtils';
import {
	readStreamLines,
	resolveMinSegmentSeconds,
	segmentSeconds,
	sliceProbeDurationSeconds,
	withHeavyTaskLimit
} from './vodJobRuntime';

export interface ChunkInspection {
	count: number;
	totalSizeBytes: number;
	largestPath: string;
	largestSizeBytes: number;
	oversizedPath?: string;
	oversizedSizeBytes?: number;
}

function resolveTargetChunkBytes(uploadLimitBytes: number): number {
	return Math.floor(uploadLimitBytes * 0.92);
}

export function resolveSegmentSecondsBySize(
	sourceSizeBytes: number,
	durationSeconds: number | undefined,
	uploadLimitBytes: number
): number {
	if (
		!durationSeconds ||
		durationSeconds <= 0 ||
		!Number.isFinite(sourceSizeBytes) ||
		sourceSizeBytes <= 0 ||
		!Number.isFinite(uploadLimitBytes) ||
		uploadLimitBytes <= 0
	) {
		return segmentSeconds;
	}

	const bytesPerSecond = sourceSizeBytes / durationSeconds;
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
		return segmentSeconds;
	}

	const targetBytes = resolveTargetChunkBytes(uploadLimitBytes);
	const bySize = Math.floor(targetBytes / bytesPerSecond);
	if (!Number.isFinite(bySize) || bySize <= 0) {
		return segmentSeconds;
	}

	return Math.max(resolveMinSegmentSeconds(), Math.min(segmentSeconds, bySize));
}

export function resolveSegmentSecondsByBitrate(
	bytesPerSecond: number,
	uploadLimitBytes: number
): number {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
		return segmentSeconds;
	}
	if (!Number.isFinite(uploadLimitBytes) || uploadLimitBytes <= 0) {
		return segmentSeconds;
	}
	const targetBytes = resolveTargetChunkBytes(uploadLimitBytes);
	const byRate = Math.floor(targetBytes / bytesPerSecond);
	if (!Number.isFinite(byRate) || byRate <= 0) {
		return segmentSeconds;
	}
	return Math.max(resolveMinSegmentSeconds(), Math.min(segmentSeconds, byRate));
}

function resolveSliceProbeSeconds(durationSeconds?: number): number {
	const configured =
		Number.isFinite(sliceProbeDurationSeconds) && sliceProbeDurationSeconds > 0
			? Math.floor(sliceProbeDurationSeconds)
			: 45;
	if (!durationSeconds || durationSeconds <= 0) {
		return configured;
	}
	return Math.max(5, Math.min(configured, Math.floor(durationSeconds)));
}

export async function estimateSourceBytesPerSecondByProbe(
	sourceFile: string,
	durationSeconds?: number
): Promise<number | undefined> {
	const probeSeconds = resolveSliceProbeSeconds(durationSeconds);
	const probeFile = `${sourceFile}.probe.mp4`;
	try {
		return await withHeavyTaskLimit(async () => {
			const args = [
				'ffmpeg',
				'-y',
				'-ss',
				'0',
				'-i',
				sourceFile,
				'-t',
				String(probeSeconds),
				'-c',
				'copy',
				'-map',
				'0',
				'-movflags',
				'+faststart',
				probeFile
			];
			const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
			const stdoutTask = new Response(proc.stdout).text();
			const stderrTask = new Response(proc.stderr).text();
			const exitCode = await proc.exited;
			await Promise.all([stdoutTask, stderrTask]);
			if (exitCode !== 0) {
				return undefined;
			}
			const info = await stat(probeFile);
			const effectiveDuration =
				durationSeconds && durationSeconds > 0
					? Math.min(durationSeconds, probeSeconds)
					: probeSeconds;
			if (effectiveDuration <= 0 || info.size <= 0) {
				return undefined;
			}
			const bytesPerSecond = info.size / effectiveDuration;
			if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
				return undefined;
			}
			return bytesPerSecond;
		});
	} catch {
		return undefined;
	} finally {
		await rm(probeFile, { force: true });
	}
}

export function resolveNextSegmentSeconds(
	currentSegmentSeconds: number,
	uploadLimitBytes: number,
	overSizedChunkBytes?: number
): number {
	const minSeconds = resolveMinSegmentSeconds();
	const fallback = Math.floor(currentSegmentSeconds * 0.7);

	let byRatio = 0;
	if (
		typeof overSizedChunkBytes === 'number' &&
		Number.isFinite(overSizedChunkBytes) &&
		overSizedChunkBytes > 0
	) {
		const targetBytes = resolveTargetChunkBytes(uploadLimitBytes);
		byRatio = Math.floor(currentSegmentSeconds * (targetBytes / overSizedChunkBytes) * 0.9);
	}

	const candidate = byRatio > 0 ? byRatio : fallback;
	return Math.max(minSeconds, Math.min(currentSegmentSeconds - 1, candidate));
}

export async function inspectGeneratedChunks(
	workDir: string,
	chunkBaseName: string,
	uploadLimitBytes: number
): Promise<ChunkInspection> {
	let count = 0;
	let totalSizeBytes = 0;
	let largestPath = '';
	let largestSizeBytes = 0;
	let oversizedPath: string | undefined;
	let oversizedSizeBytes: number | undefined;

	for await (const name of new Bun.Glob(`${chunkBaseName}_*.mp4`).scan({
		cwd: workDir
	})) {
		const fullPath = `${workDir}/${name}`;
		const info = await stat(fullPath);
		count += 1;
		totalSizeBytes += info.size;
		if (info.size > largestSizeBytes) {
			largestSizeBytes = info.size;
			largestPath = fullPath;
		}
		if (!oversizedPath && info.size > uploadLimitBytes) {
			oversizedPath = fullPath;
			oversizedSizeBytes = info.size;
		}
	}

	if (count === 0) {
		throw new Error('Chunk files were not generated after slicing');
	}

	return {
		count,
		totalSizeBytes,
		largestPath,
		largestSizeBytes,
		oversizedPath,
		oversizedSizeBytes
	};
}

function buildSliceCommand(
	sourceFile: string,
	chunksPattern: string,
	effectiveSegmentSeconds: number,
	mode: SliceMode
): string[] {
	if (mode === 'reencode') {
		return [
			'ffmpeg',
			'-y',
			'-i',
			sourceFile,
			'-map',
			'0:v:0',
			'-map',
			'0:a:0?',
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			'-crf',
			'23',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-force_key_frames',
			`expr:gte(t,n_forced*${effectiveSegmentSeconds})`,
			'-f',
			'segment',
			'-segment_format_options',
			'movflags=+faststart',
			'-segment_time',
			String(effectiveSegmentSeconds),
			'-reset_timestamps',
			'1',
			chunksPattern
		];
	}

	return [
		'ffmpeg',
		'-y',
		'-i',
		sourceFile,
		'-map',
		'0:v:0',
		'-map',
		'0:a?',
		'-dn',
		'-sn',
		'-c',
		'copy',
		'-f',
		'segment',
		'-segment_format_options',
		'movflags=+faststart',
		'-segment_time',
		String(effectiveSegmentSeconds),
		'-reset_timestamps',
		'1',
		'-break_non_keyframes',
		'1',
		chunksPattern
	];
}

function parseHmsToSeconds(value: string): number | undefined {
	const match = value.match(/^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
	if (!match) {
		return undefined;
	}
	const hours = Number.parseInt(match[1] ?? '0', 10);
	const minutes = Number.parseInt(match[2] ?? '0', 10);
	const seconds = Number.parseFloat(match[3] ?? '0');
	if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
		return undefined;
	}
	return hours * 3600 + minutes * 60 + seconds;
}

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function parseSliceProgressRatio(line: string, durationSeconds?: number): number | undefined {
	if (!durationSeconds || durationSeconds <= 0) {
		return undefined;
	}
	const match = line.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
	if (!match?.[1]) {
		return undefined;
	}
	const currentSeconds = parseHmsToSeconds(match[1]);
	if (typeof currentSeconds !== 'number' || currentSeconds < 0) {
		return undefined;
	}
	return clampRatio(currentSeconds / durationSeconds);
}

function quoteArg(value: string): string {
	if (/[\s"]/u.test(value)) {
		return `"${value.replaceAll('"', '\\"')}"`;
	}
	return value;
}

function tailText(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	return value.slice(-maxChars);
}

function trimLineForLog(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

async function collectFfprobeSummary(sourceFile: string): Promise<string> {
	try {
		const args = [
			'ffprobe',
			'-v',
			'error',
			'-show_entries',
			'format=duration,size,format_name:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate',
			'-of',
			'json',
			sourceFile
		];
		const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);
		if (exitCode !== 0) {
			return `ffprobe_failed(exit=${exitCode}): ${tailText(stderr || 'no stderr', 1200)}`;
		}
		return tailText(stdout || 'ffprobe returned empty output', 2000);
	} catch (error) {
		return `ffprobe_exception: ${formatUnknownError(error)}`;
	}
}

export async function removeGeneratedChunks(
	workDir: string,
	chunkBaseName: string
): Promise<void> {
	for await (const name of new Bun.Glob(`${chunkBaseName}_*.mp4`).scan({
		cwd: workDir
	})) {
		await rm(`${workDir}/${name}`, { force: true });
	}
}

export async function sliceChunksWithProgress(
	sourceFile: string,
	chunksPattern: string,
	effectiveSegmentSeconds: number,
	mode: SliceMode,
	durationSeconds: number | undefined,
	onProgress: (ratio: number) => Promise<void>
): Promise<void> {
	await withHeavyTaskLimit(async () => {
		const args = buildSliceCommand(sourceFile, chunksPattern, effectiveSegmentSeconds, mode);
		const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const stderrLines: string[] = [];
		let lastRatio = 0;
		const stdoutTask = new Response(proc.stdout).text();
		const stderrTask = readStreamLines(proc.stderr, async line => {
			stderrLines.push(trimLineForLog(line, 600));
			if (stderrLines.length > 200) {
				stderrLines.splice(0, stderrLines.length - 200);
			}
			const ratio = parseSliceProgressRatio(line, durationSeconds);
			if (typeof ratio !== 'number') {
				return;
			}
			if (ratio <= lastRatio) {
				return;
			}
			lastRatio = ratio;
			await onProgress(ratio);
		});

		const exitCode = await proc.exited;
		await Promise.all([stdoutTask, stderrTask]);
		if (exitCode !== 0) {
			const stderrTail = tailText(stderrLines.join('\n') || 'no stderr output', 3500);
			const ffprobeSummary = await collectFfprobeSummary(sourceFile);
			const commandText = args.map(quoteArg).join(' ');
			throw new Error(
				[
					`slicing failed (ffmpeg exit ${exitCode})`,
					`mode=${mode}`,
					`segmentSeconds=${effectiveSegmentSeconds}`,
					`command=${commandText}`,
					`ffmpeg_stderr_tail=${trimOutput(stderrTail)}`,
					`ffprobe=${trimOutput(ffprobeSummary)}`
				].join(' | ')
			);
		}
		await onProgress(1);
	});
}