import { spawn } from 'bun';
import { trimOutput } from './vodJobUtils';

export const dataDir = process.env.DATA_DIR ?? '/data/streams';
const parsedSegmentSeconds = Number.parseInt(
	process.env.VOD_SEGMENT_SECONDS ?? '2400',
	10
);
export const segmentSeconds =
	Number.isFinite(parsedSegmentSeconds) && parsedSegmentSeconds > 0
		? Math.floor(parsedSegmentSeconds)
		: 2400;
export const minSegmentSeconds = 1;
export const maxAdaptiveSliceAttempts = 10;
export const cleanupDelayMs = 15000;
export const vodMetadataFileName = 'vod-metadata.json';
export const heavyTaskMaxConcurrent = Number.parseInt(
	process.env.HEAVY_TASK_MAX_CONCURRENT ?? '2',
	10
);
export const sliceProbeDurationSeconds = Number.parseInt(
	process.env.SLICE_PROBE_DURATION_SECONDS ?? '45',
	10
);

function resolveDownloaderBinary(): string {
	const envBin = process.env.YTDLP_BIN?.trim();
	if (envBin && Bun.which(envBin)) {
		return envBin;
	}

	const candidates = ['ytdl', 'yt-dlp'];
	for (const candidate of candidates) {
		if (Bun.which(candidate)) {
			return candidate;
		}
	}

	return 'yt-dlp';
}

export const downloaderBinary = resolveDownloaderBinary();

const normalizedHeavyTaskMaxConcurrent =
	Number.isFinite(heavyTaskMaxConcurrent) && heavyTaskMaxConcurrent > 0
		? Math.floor(heavyTaskMaxConcurrent)
		: 2;
let activeHeavyTasks = 0;
const heavyTaskQueue: Array<() => void> = [];

async function acquireHeavyTaskSlot(): Promise<void> {
	if (activeHeavyTasks < normalizedHeavyTaskMaxConcurrent) {
		activeHeavyTasks += 1;
		return;
	}
	await new Promise<void>(resolve => {
		heavyTaskQueue.push(() => {
			activeHeavyTasks += 1;
			resolve();
		});
	});
}

function releaseHeavyTaskSlot(): void {
	activeHeavyTasks = Math.max(0, activeHeavyTasks - 1);
	const next = heavyTaskQueue.shift();
	if (next) {
		next();
	}
}

export async function withHeavyTaskLimit<T>(task: () => Promise<T>): Promise<T> {
	await acquireHeavyTaskSlot();
	try {
		return await task();
	} finally {
		releaseHeavyTaskSlot();
	}
}

export function resolveMinSegmentSeconds(): number {
	if (!Number.isFinite(minSegmentSeconds) || minSegmentSeconds < 1) {
		return 1;
	}
	return Math.floor(minSegmentSeconds);
}

export function resolveMaxAdaptiveSliceAttempts(): number {
	if (!Number.isFinite(maxAdaptiveSliceAttempts) || maxAdaptiveSliceAttempts < 1) {
		return 5;
	}
	return Math.floor(maxAdaptiveSliceAttempts);
}

export async function runCommand(
	args: string[],
	stage: string
): Promise<{ stdout: string; stderr: string }> {
	return withHeavyTaskLimit(async () => {
		const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);

		if (exitCode !== 0) {
			const details = trimOutput(stderr || stdout || 'no output');
			throw new Error(
				`${stage} failed (${args[0]} exit ${exitCode}): ${details}`
			);
		}

		return { stdout, stderr };
	});
}

export async function readStreamLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => Promise<void> | void
): Promise<void> {
	if (!stream) {
		return;
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const lineBreakIndex = buffer.search(/[\r\n]/);
				if (lineBreakIndex === -1) {
					break;
				}
				const line = buffer.slice(0, lineBreakIndex).trim();
				buffer = buffer.slice(lineBreakIndex + 1);
				if (line.length > 0) {
					await onLine(line);
				}
			}
		}
		buffer += decoder.decode();
		const tail = buffer.trim();
		if (tail.length > 0) {
			await onLine(tail);
		}
	} finally {
		reader.releaseLock();
	}
}