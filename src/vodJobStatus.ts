import { bot } from './config';
import { logger } from './logger';
import type { JobState, VodJob } from './vodJobTypes';
import { formatUnknownError } from './vodJobUtils';

const log = logger.init('vod');
const statusUpdateMinIntervalMs = Number(process.env.STATUS_UPDATE_MIN_INTERVAL_MS ?? 1200);

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
			return 'Queued';
		case 'metadata':
			return 'Metadata';
		case 'downloading':
			return 'Downloading';
		case 'slicing':
			return 'Slicing';
		case 'uploading':
			return 'Uploading to Telegram';
		case 'done':
			return 'Done';
		case 'error':
			return 'Error';
		default:
			return state;
	}
}

export function defaultProgressForState(state: JobState): number {
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

export function progressWithinStage(state: JobState, ratio: number): number {
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

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.floor(value)));
}

function stateIcon(state: JobState): string {
	switch (state) {
		case 'queued':
			return '[queue]';
		case 'metadata':
			return '[meta]';
		case 'downloading':
			return '[down]';
		case 'slicing':
			return '[slice]';
		case 'uploading':
			return '[upload]';
		case 'done':
			return '[done]';
		case 'error':
			return '[error]';
		default:
			return '[?]';
	}
}

function renderProgressBar(percent: number): string {
	const size = 16;
	const filled = Math.round((clampPercent(percent) / 100) * size);
	return `[${'#'.repeat(filled)}${'-'.repeat(size - filled)}]`;
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
		const marker = done ? '[done]' : active ? '[live]' : '[wait]';
		return `${marker} ${stateLabel(item)}`;
	});
}

function buildStatusText(job: VodJob): string {
	const progress = clampPercent(job.progress);
	const lines = [
		`${stateIcon(job.state)} Job ${job.id}`,
		'',
		`Stage   : ${stateLabel(job.state)}`,
		`Progress: ${renderProgressBar(progress)} ${progress}%`,
		'',
		'Pipeline:',
		...buildStageList(job.state)
	];
	if (job.error) {
		lines.push('', `Error: ${job.error}`);
	}
	if (job.publishSummary) {
		lines.push('', `Publish: ${job.publishSummary}`);
	}
	return lines.join('\n');
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

export async function setStateAndNotify(
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