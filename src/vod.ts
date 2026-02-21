import { rm, stat } from 'node:fs/promises';
import { spawn } from 'bun';
import { bot, DEFAULT_TARGET_CHAT_ID } from './config';
import {
	createUploadHistoryEntry,
	updateUploadHistoryContext,
	updateUploadHistoryStatus
} from './history';
import { logger } from './logger';
import { type UploadMetadata, uploadChunks } from './upload';

const log = logger.init('vod');

type JobState =
	| 'queued'
	| 'metadata'
	| 'downloading'
	| 'slicing'
	| 'uploading'
	| 'done'
	| 'error';

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
	error?: string;
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
const segmentSeconds = Number(process.env.VOD_SEGMENT_SECONDS ?? 2400);
const telegramUploadLimitMb = 1900;
const cleanupDelayMs = 15000;
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
		!Number.isFinite(telegramUploadLimitMb) ||
		telegramUploadLimitMb <= 0
	) {
		return segmentSeconds;
	}

	const bytesPerSecond = sourceSizeBytes / durationSeconds;
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
		return segmentSeconds;
	}

	const targetBytes = Math.floor(telegramUploadLimitMb * 1024 * 1024 * 0.92);
	const bySize = Math.floor(targetBytes / bytesPerSecond);
	if (!Number.isFinite(bySize) || bySize <= 0) {
		return segmentSeconds;
	}

	return Math.max(30, Math.min(segmentSeconds, bySize));
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
	job.progress = progressForState(state);
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

function progressForState(state: JobState): number {
	switch (state) {
		case 'queued':
			return 5;
		case 'metadata':
			return 20;
		case 'downloading':
			return 45;
		case 'slicing':
			return 70;
		case 'uploading':
			return 85;
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
	return lines.join('\n');
}

async function setStateAndNotify(
	job: VodJob,
	state: JobState,
	error?: string,
	progress?: number
): Promise<void> {
	setState(job, state, error, progress);
	log.info('Job state updated', {
		jobId: job.id,
		state,
		progress: job.progress,
		hasError: Boolean(error)
	});
	const text = buildStatusText(job);
	if (text === job.lastStatusText) {
		return;
	}

	try {
		if (job.statusMessageId) {
			await bot.api.editMessageText(job.requestedByChatId, job.statusMessageId, text);
		} else {
			const message = await bot.api.sendMessage(job.requestedByChatId, text);
			job.statusMessageId = message.message_id;
		}
		job.lastStatusText = text;
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
	}
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
	const chunkBaseName = sanitizeFileName(metadata.streamTitle);
	const chunksPattern = `${workDir}/${chunkBaseName}_%03d.mp4`;

	await setStateAndNotify(job, 'downloading');
	updateUploadHistoryStatus(job.id, 'downloading');
	await runCommand(
		[
			downloaderBinary,
			'--no-warnings',
			'--no-progress',
			'-f',
			'best[ext=mp4]/best',
			'-o',
			sourceFile,
			job.url
		],
		'download'
	);

	const sourceStat = await stat(sourceFile);
	const durationSeconds = parseDurationStringToSeconds(metadata.durationText);
	const effectiveSegmentSeconds = resolveSegmentSecondsBySize(
		sourceStat.size,
		durationSeconds
	);

	await setStateAndNotify(job, 'slicing');
	updateUploadHistoryStatus(job.id, 'slicing');
	await runCommand(
		[
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
			chunksPattern
		],
		'slicing'
	);

	await setStateAndNotify(job, 'uploading');
	updateUploadHistoryStatus(job.id, 'uploading');
	await uploadChunks(
		workDir,
		metadata,
		job.targetChatId,
		chunkBaseName,
		async (uploadedCount, totalCount) => {
			const ratio = totalCount > 0 ? uploadedCount / totalCount : 0;
			const percent = 85 + Math.floor(ratio * 14);
			await setStateAndNotify(job, 'uploading', undefined, percent);
		}
	);
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
		progress: progressForState('queued'),
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