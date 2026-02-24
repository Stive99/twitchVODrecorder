import { rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'bun';
import { bot, DEFAULT_TARGET_CHAT_ID } from './config';
import {
	createUploadHistoryEntry,
	updateUploadHistoryContext,
	updateUploadHistoryStatus
} from './history';
import { logger } from './logger';
import {
	ChunkTooLargeError,
	type UploadMetadata,
	type UploadProgress,
	resolveTelegramUploadLimitBytes,
	uploadChunks
} from './upload';

const log = logger.init('vod');

type JobState =
	| 'queued'
	| 'metadata'
	| 'downloading'
	| 'slicing'
	| 'uploading'
	| 'done'
	| 'error';

type SliceMode = 'copy' | 'reencode';

interface VodJob {
	id: string;
	url: string;
	requestedByChatId: number;
	targetChatId: string | number;
	state: JobState;
	progress: number;
	createdAt: number;
	updatedAt: number;
	statusMessageId?: number;
	lastStatusText?: string;
	lastStatusSentAt?: number;
	lastNotifiedState?: JobState;
	lastNotifiedProgress?: number;
	error?: string;
	publishSummary?: string;
}

interface EnqueueVodOptions {
	startAfter?: Promise<unknown>;
}

interface YtInfo {
	title?: string;
	channel?: string;
	channel_id?: string;
	channel_url?: string;
	uploader?: string;
	uploader_id?: string;
	uploader_url?: string;
	duration?: number;
	duration_string?: string;
	categories?: string[];
	chapters?: Array<{ title?: string; start_time?: number }>;
	timestamp?: number;
	release_timestamp?: number;
	upload_date?: string;
}

const dataDir = process.env.DATA_DIR ?? '/data/streams';
const segmentSeconds = 2400;
const telegramUploadLimitBytes = resolveTelegramUploadLimitBytes();
const minSegmentSeconds = 1;
const maxAdaptiveSliceAttempts = 10;
const cleanupDelayMs = 15000;
const statusUpdateMinIntervalMs = Number(process.env.STATUS_UPDATE_MIN_INTERVAL_MS ?? 1200);
const vodMetadataFileName = 'vod-metadata.json';
const jobs = new Map<string, VodJob>();
let activeQueue = Promise.resolve();

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

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

const downloaderBinary = resolveDownloaderBinary();

function toHms(totalSeconds: number): string {
	const sec = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function toHm(totalSeconds: number): string {
	const sec = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function sanitizeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

function sanitizeFileName(value: string): string {
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

function parseSourceId(url: string): string {
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

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	return JSON.stringify(error);
}

function trimOutput(value: string): string {
	return value.trim().slice(0, 1600);
}

function formatStreamDate(info: YtInfo): string | undefined {
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

function parseDurationStringToSeconds(value: string): number | undefined {
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

function resolveDurationSeconds(info: YtInfo): number | undefined {
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

function resolveSegmentSecondsBySize(
	sourceSizeBytes: number,
	durationSeconds: number | undefined
): number {
	if (
		!durationSeconds ||
		durationSeconds <= 0 ||
		!Number.isFinite(sourceSizeBytes) ||
		sourceSizeBytes <= 0 ||
		!Number.isFinite(telegramUploadLimitBytes) ||
		telegramUploadLimitBytes <= 0
	) {
		return segmentSeconds;
	}

	const bytesPerSecond = sourceSizeBytes / durationSeconds;
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
		return segmentSeconds;
	}

	const targetBytes = Math.floor(telegramUploadLimitBytes * 0.92);
	const bySize = Math.floor(targetBytes / bytesPerSecond);
	if (!Number.isFinite(bySize) || bySize <= 0) {
		return segmentSeconds;
	}

	return Math.max(resolveMinSegmentSeconds(), Math.min(segmentSeconds, bySize));
}

function resolveMinSegmentSeconds(): number {
	if (!Number.isFinite(minSegmentSeconds) || minSegmentSeconds < 1) {
		return 1;
	}
	return Math.floor(minSegmentSeconds);
}

function resolveMaxAdaptiveSliceAttempts(): number {
	if (!Number.isFinite(maxAdaptiveSliceAttempts) || maxAdaptiveSliceAttempts < 1) {
		return 5;
	}
	return Math.floor(maxAdaptiveSliceAttempts);
}

function resolveTargetChunkBytes(): number {
	return Math.floor(telegramUploadLimitBytes * 0.92);
}

interface ChunkInspection {
	count: number;
	largestPath: string;
	largestSizeBytes: number;
	oversizedPath?: string;
	oversizedSizeBytes?: number;
}

async function inspectGeneratedChunks(
	workDir: string,
	chunkBaseName: string,
	uploadLimitBytes: number
): Promise<ChunkInspection> {
	let count = 0;
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
		largestPath,
		largestSizeBytes,
		oversizedPath,
		oversizedSizeBytes
	};
}

function resolveNextSegmentSeconds(
	currentSegmentSeconds: number,
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
		const targetBytes = resolveTargetChunkBytes();
		byRatio = Math.floor(currentSegmentSeconds * (targetBytes / overSizedChunkBytes) * 0.9);
	}

	const candidate = byRatio > 0 ? byRatio : fallback;
	return Math.max(minSeconds, Math.min(currentSegmentSeconds - 1, candidate));
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
		'-c',
		'copy',
		'-map',
		'0',
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

async function removeGeneratedChunks(
	workDir: string,
	chunkBaseName: string
): Promise<void> {
	for await (const name of new Bun.Glob(`${chunkBaseName}_*.mp4`).scan({
		cwd: workDir
	})) {
		await rm(`${workDir}/${name}`, { force: true });
	}
}

function isNumericOnly(value: string): boolean {
	return /^\d+$/.test(value);
}

function normalizeChannelName(value: string): string {
	return value.trim().replace(/^@/, '');
}

function resolveChannelName(info: YtInfo): string {
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

function resolveChannelUrl(info: YtInfo): string | undefined {
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

async function runCommand(
	args: string[],
	stage: string
): Promise<{ stdout: string; stderr: string }> {
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
}

async function notifyJobStatus(chatId: number, text: string): Promise<void> {
	try {
		await bot.api.sendMessage(chatId, text);
	} catch (notifyError) {
		log.warn('Failed to notify chat', {
			chatId,
			error: formatUnknownError(notifyError)
		});
	}
}

export function extractVodUrl(text: string): string | null {
	const match = text.match(
		/https?:\/\/(?:www\.)?(?:twitch\.tv\/videos\/\d+|twitch\.tv\/[A-Za-z0-9_]+\/clip\/[A-Za-z0-9_-]+|clips\.twitch\.tv\/[A-Za-z0-9_-]+)/i
	);
	return match?.[0] ?? null;
}

function setState(
	job: VodJob,
	state: JobState,
	error?: string,
	progress?: number
): void {
	job.state = state;
	job.updatedAt = Date.now();
	job.error = error;
	if (typeof progress === 'number') {
		job.progress = clampPercent(progress);
		return;
	}
	if (state === 'error') {
		job.progress = Math.max(job.progress, 1);
		return;
	}
	job.progress = defaultProgressForState(state);
}

function stateLabel(state: JobState): string {
	switch (state) {
		case 'queued':
			return 'в очереди';
		case 'metadata':
			return 'получение метаданных';
		case 'downloading':
			return 'скачивание';
		case 'slicing':
			return 'нарезка';
		case 'uploading':
			return 'загрузка в Telegram';
		case 'done':
			return 'завершено';
		case 'error':
			return 'ошибка';
		default:
			return state;
	}
}

function defaultProgressForState(state: JobState): number {
	switch (state) {
		case 'queued':
			return 0;
		case 'metadata':
			return 8;
		case 'downloading':
			return 12;
		case 'slicing':
			return 70;
		case 'uploading':
			return 84;
		case 'done':
			return 100;
		case 'error':
			return 0;
		default:
			return 0;
	}
}

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function progressWithinStage(state: JobState, ratio: number): number {
	const normalized = clampRatio(ratio);
	switch (state) {
		case 'queued':
			return Math.floor(normalized * 7);
		case 'metadata':
			return 8 + Math.floor(normalized * 4);
		case 'downloading':
			return 12 + Math.floor(normalized * 58);
		case 'slicing':
			return 70 + Math.floor(normalized * 14);
		case 'uploading':
			return 84 + Math.floor(normalized * 15);
		case 'done':
			return 100;
		case 'error':
			return 0;
		default:
			return 0;
	}
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.floor(value)));
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

function stateIcon(state: JobState): string {
	switch (state) {
		case 'queued':
			return '🕒';
		case 'metadata':
			return '🧠';
		case 'downloading':
			return '⬇️';
		case 'slicing':
			return '✂️';
		case 'uploading':
			return '📤';
		case 'done':
			return '✅';
		case 'error':
			return '❌';
		default:
			return '•';
	}
}

function renderProgressBar(percent: number): string {
	const size = 12;
	const filled = Math.round((clampPercent(percent) / 100) * size);
	return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function buildStageList(state: JobState): string[] {
	const stages: JobState[] = [
		'queued',
		'metadata',
		'downloading',
		'slicing',
		'uploading',
		'done'
	];
	const currentIndex = stages.indexOf(state === 'error' ? 'uploading' : state);
	return stages.map((item, index) => {
		const done = index < currentIndex || state === 'done';
		const active = index === currentIndex && state !== 'done' && state !== 'error';
		const prefix = done ? '✓' : active ? '→' : '·';
		return `${prefix} ${stateLabel(item)}`;
	});
}

function buildStatusText(job: VodJob): string {
	const progress = clampPercent(job.progress);
	const lines = [
		`${stateIcon(job.state)} Задача ${job.id}`,
		'',
		`Статус: ${stateLabel(job.state)}`,
		`Прогресс: ${renderProgressBar(progress)} ${progress}%`,
		'',
		...buildStageList(job.state)
	];
	if (job.error) {
		lines.push('', `Ошибка: ${job.error}`);
	}
	if (job.publishSummary) {
		lines.push('', `Публикация: ${job.publishSummary}`);
	}
	return lines.join('\n');
}

async function setStateAndNotify(
	job: VodJob,
	state: JobState,
	error?: string,
	progress?: number
): Promise<void> {
	const prevState = job.state;
	const prevProgress = job.progress;
	const prevError = job.error;
	setState(job, state, error, progress);
	const stateChanged = prevState !== job.state;
	const progressChanged = prevProgress !== job.progress;
	const errorChanged = prevError !== job.error;
	if (!stateChanged && !progressChanged && !errorChanged && job.statusMessageId) {
		return;
	}

	const isTerminal = state === 'done' || state === 'error';
	const notifiedStateChanged = job.lastNotifiedState !== state;
	const progressDelta = Math.abs(job.progress - (job.lastNotifiedProgress ?? 0));
	const minInterval = Number.isFinite(statusUpdateMinIntervalMs) && statusUpdateMinIntervalMs >= 0
		? Math.floor(statusUpdateMinIntervalMs)
		: 1200;
	if (!isTerminal && !notifiedStateChanged) {
		const elapsed = Date.now() - (job.lastStatusSentAt ?? 0);
		if (elapsed < minInterval && progressDelta < 2) {
			return;
		}
	}

	const text = buildStatusText(job);
	if (text === job.lastStatusText) {
		return;
	}
	log.info('Job state updated', {
		jobId: job.id,
		state,
		progress: job.progress,
		hasError: Boolean(error)
	});

	try {
		if (job.statusMessageId) {
			await bot.api.editMessageText(job.requestedByChatId, job.statusMessageId, text);
		} else {
			const message = await bot.api.sendMessage(job.requestedByChatId, text);
			job.statusMessageId = message.message_id;
		}
		job.lastStatusText = text;
		job.lastStatusSentAt = Date.now();
		job.lastNotifiedState = state;
		job.lastNotifiedProgress = job.progress;
	} catch (notifyError) {
		const errorText = formatUnknownError(notifyError);
		if (errorText.includes('message is not modified')) {
			return;
		}
		log.warn('Failed to update job status message', {
			jobId: job.id,
			error: errorText
		});
		await notifyJobStatus(job.requestedByChatId, text);
		job.lastStatusSentAt = Date.now();
		job.lastNotifiedState = state;
		job.lastNotifiedProgress = job.progress;
	}
}

function parseDownloadPercent(line: string): number | undefined {
	const match = line.match(/(\d{1,3}(?:\.\d+)?)%/);
	if (!match?.[1]) {
		return undefined;
	}
	const parsed = Number.parseFloat(match[1]);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, parsed));
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

async function readStreamLines(
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

async function downloadVodWithProgress(
	job: VodJob,
	sourceFile: string
): Promise<void> {
	const args = [
		downloaderBinary,
		'--no-warnings',
		'--newline',
		'--progress',
		'-f',
		'best[ext=mp4]/best',
		'-o',
		sourceFile,
		job.url
	];
	const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let lastPercent = 0;
	let stderrText = '';
	const stdoutTask = readStreamLines(proc.stdout, async line => {
		const percent = parseDownloadPercent(line);
		if (typeof percent !== 'number') {
			return;
		}
		if (percent <= lastPercent) {
			return;
		}
		lastPercent = percent;
		await setStateAndNotify(
			job,
			'downloading',
			undefined,
			progressWithinStage('downloading', percent / 100)
		);
	});
	const stderrTask = readStreamLines(proc.stderr, line => {
		stderrText = `${stderrText}\n${line}`.trim().slice(-4000);
	});
	const exitCode = await proc.exited;
	await Promise.all([stdoutTask, stderrTask]);
	if (exitCode !== 0) {
		throw new Error(
			`download failed (${downloaderBinary} exit ${exitCode}): ${trimOutput(stderrText || 'no output')}`
		);
	}
	await setStateAndNotify(job, 'downloading', undefined, progressWithinStage('downloading', 1));
}

async function sliceChunksWithProgress(
	sourceFile: string,
	chunksPattern: string,
	effectiveSegmentSeconds: number,
	mode: SliceMode,
	durationSeconds: number | undefined,
	onProgress: (ratio: number) => Promise<void>
): Promise<void> {
	const args = buildSliceCommand(sourceFile, chunksPattern, effectiveSegmentSeconds, mode);
	const proc = spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let stderrText = '';
	let lastRatio = 0;
	const stdoutTask = new Response(proc.stdout).text();
	const stderrTask = readStreamLines(proc.stderr, async line => {
		stderrText = `${stderrText}\n${line}`.trim().slice(-4000);
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
		throw new Error(`slicing failed (ffmpeg exit ${exitCode}): ${trimOutput(stderrText || 'no output')}`);
	}
	await onProgress(1);
}

async function loadVodMetadata(url: string): Promise<UploadMetadata> {
	const { stdout } = await runCommand(
		[
			downloaderBinary,
			'--dump-single-json',
			'--skip-download',
			'--no-warnings',
			url
		],
		'metadata'
	);

	const info = JSON.parse(stdout) as YtInfo;
	const durationSeconds = resolveDurationSeconds(info);
	const category = info.categories?.[0] ?? 'Unknown';
	const chapters = Array.isArray(info.chapters) ? info.chapters : [];

	const titles = chapters
		.filter(ch => typeof ch.title === 'string' && ch.title.trim().length > 0)
		.map(ch => {
			const start =
				typeof ch.start_time === 'number' && ch.start_time > 0
					? ` | Начало - ${toHm(ch.start_time)}`
					: '';
			return {
				title: `${ch.title?.trim() ?? 'Без названия'}${start}`,
				category
			};
		})
		.slice(0, 12);

	const normalizedTitles =
		titles.length > 0
			? titles
			: [{ title: info.title ?? 'Без названия', category }];

	return {
		streamTitle: info.title?.trim() || 'Без названия',
		streamDate: formatStreamDate(info),
		channel: resolveChannelName(info),
		channelUrl: resolveChannelUrl(info),
		durationText:
			typeof durationSeconds === 'number' ? toHms(durationSeconds) : 'Unknown',
		titles: normalizedTitles,
		vodUrl: url
	};
}

async function saveVodMetadataSnapshot(
	workDir: string,
	metadata: UploadMetadata
): Promise<void> {
	const metadataPath = `${workDir}/${vodMetadataFileName}`;
	await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}
async function processVod(job: VodJob): Promise<void> {
	const sourceId = parseSourceId(job.url);
	const workDir = `${dataDir}/${sourceId}-${Date.now()}`;
	const sourceFile = `${workDir}/source.mp4`;

	await Bun.$`mkdir -p ${workDir}`;
	updateUploadHistoryContext(job.id, { workDir });

	await setStateAndNotify(job, 'metadata');
	updateUploadHistoryStatus(job.id, 'metadata');
	const metadata = await loadVodMetadata(job.url);
	updateUploadHistoryContext(job.id, { streamTitle: metadata.streamTitle });
	await saveVodMetadataSnapshot(workDir, metadata);
	const chunkBaseName = sanitizeFileName(metadata.streamTitle);
	const chunksPattern = `${workDir}/${chunkBaseName}_%03d.mp4`;

	await setStateAndNotify(job, 'downloading');
	updateUploadHistoryStatus(job.id, 'downloading');
	await downloadVodWithProgress(job, sourceFile);

	const sourceStat = await stat(sourceFile);
	const durationSeconds = parseDurationStringToSeconds(metadata.durationText);
	let effectiveSegmentSeconds = resolveSegmentSecondsBySize(
		sourceStat.size,
		durationSeconds
	);
	let sliceMode: SliceMode = 'copy';
	let uploadCompleted = false;
	const minAllowedSegmentSeconds = resolveMinSegmentSeconds();
	const maxAttempts = resolveMaxAdaptiveSliceAttempts();

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await removeGeneratedChunks(workDir, chunkBaseName);

		await setStateAndNotify(job, 'slicing');
		updateUploadHistoryStatus(job.id, 'slicing');
		await setStateAndNotify(
			job,
			'slicing',
			undefined,
			progressWithinStage('slicing', (attempt - 1) / maxAttempts)
		);
		await sliceChunksWithProgress(
			sourceFile,
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
		await setStateAndNotify(
			job,
			'slicing',
			undefined,
			progressWithinStage('slicing', attempt / maxAttempts)
		);

		const chunkInspection = await inspectGeneratedChunks(
			workDir,
			chunkBaseName,
			resolveTelegramUploadLimitBytes()
		);
		log.info('Chunk inspection after slicing', {
			jobId: job.id,
			attempt,
			sliceMode,
			effectiveSegmentSeconds,
			chunkCount: chunkInspection.count,
			largestChunkPath: chunkInspection.largestPath,
			largestChunkBytes: chunkInspection.largestSizeBytes
		});
		if (chunkInspection.oversizedPath) {
			if (sliceMode === 'copy') {
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
				chunkInspection.oversizedSizeBytes
			);
			if (nextSegmentSeconds >= effectiveSegmentSeconds) {
				throw new ChunkTooLargeError(
					chunkInspection.oversizedPath,
					chunkInspection.oversizedSizeBytes
				);
			}

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

		await setStateAndNotify(job, 'uploading');
		updateUploadHistoryStatus(job.id, 'uploading');
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
				}
			);
			uploadCompleted = true;
			const totalUploadedBytes =
				lastUploadProgress?.totalBytes ?? sourceStat.size;
			job.publishSummary = [
				`${chunkInspection.count} файлов`,
				`объем ${formatBytes(totalUploadedBytes)}`,
				`попытка ${attempt}/${maxAttempts}`,
				`режим ${sliceMode}`,
				`сегмент ${effectiveSegmentSeconds}с`
			].join(', ');
			log.info('Telegram publish attempt succeeded', {
				jobId: job.id,
				attempt,
				sliceMode,
				effectiveSegmentSeconds
			});
			break;
		} catch (error) {
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

			if (sliceMode === 'copy') {
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
				overSizedChunkBytes
			);
			if (nextSegmentSeconds >= effectiveSegmentSeconds) {
				throw error;
			}

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

	await setStateAndNotify(job, 'done', undefined, 100);
	updateUploadHistoryStatus(job.id, 'done');
}

export function enqueueVod(
	url: string,
	requestedByChatId: number,
	options: EnqueueVodOptions = {}
): { jobId: string } {
	const targetChatId = DEFAULT_TARGET_CHAT_ID ?? requestedByChatId;
	const job: VodJob = {
		id: `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
		url,
		requestedByChatId,
		targetChatId,
		state: 'queued',
		progress: defaultProgressForState('queued'),
		createdAt: Date.now(),
		updatedAt: Date.now()
	};

	jobs.set(job.id, job);
	createUploadHistoryEntry({
		jobId: job.id,
		requestedByChatId: job.requestedByChatId,
		targetChatId: job.targetChatId,
		vodUrl: job.url
	});
	log.info('VOD job enqueued', {
		jobId: job.id,
		requestedByChatId,
		targetChatId,
		url
	});
	activeQueue = activeQueue
		.then(async () => {
			try {
				if (options.startAfter) {
					await options.startAfter;
				}
				await setStateAndNotify(job, 'queued');
				await processVod(job);
			} catch (error) {
				const errorText = formatUnknownError(error);
				log.error('VOD job failed', { jobId: job.id, error: errorText });
				updateUploadHistoryStatus(job.id, 'error', errorText);
				await setStateAndNotify(job, 'error', errorText);
			}
		})
		.catch(() => undefined);

	return { jobId: job.id };
}

export function getStatusText(): string {
	const list = Array.from(jobs.values())
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, 10);
	if (list.length === 0) {
		return 'Нет задач';
	}

	const lines = list.map(job => {
		const base = `${job.id}: ${job.state} (${clampPercent(job.progress)}%)`;
		return job.error ? `${base} (${job.error})` : base;
	});

	return ['Статус задач:', ...lines].join('\n');
}