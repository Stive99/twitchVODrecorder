import { DEFAULT_TARGET_CHAT_ID } from './config';
import { logger } from './logger';
import {
	clampPercent,
	createHistoryEntry,
	defaultProgressForState,
	formatUnknownVodError,
	markJobFailed,
	processVod,
	setStateAndNotify,
	type VodJob
} from './vodJob';

const log = logger.init('vod');

interface EnqueueVodOptions {
	startAfter?: Promise<unknown>;
}

const jobs = new Map<string, VodJob>();
let activeQueue = Promise.resolve();

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
	createHistoryEntry(job);
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
				const errorText = formatUnknownVodError(error);
				log.error('VOD job failed', { jobId: job.id, error: errorText });
				markJobFailed(job.id, errorText);
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