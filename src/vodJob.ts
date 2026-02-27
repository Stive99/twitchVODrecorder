import {
	createUploadHistoryEntry,
	updateUploadHistoryStatus
} from './history';
import { processVod } from './vodJobOrchestrator';
import {
	clampPercent,
	defaultProgressForState,
	progressWithinStage,
	setStateAndNotify
} from './vodJobStatus';
import type { JobState, VodJob } from './vodJobTypes';
import { extractVodUrl, formatUnknownError } from './vodJobUtils';

export type { JobState, VodJob };
export {
	clampPercent,
	defaultProgressForState,
	extractVodUrl,
	processVod,
	progressWithinStage,
	setStateAndNotify
};

export function createHistoryEntry(job: VodJob): void {
	createUploadHistoryEntry({
		jobId: job.id,
		requestedByChatId: job.requestedByChatId,
		targetChatId: job.targetChatId,
		vodUrl: job.url
	});
}

export function markJobFailed(jobId: string, errorText: string): void {
	updateUploadHistoryStatus(jobId, 'error', errorText);
}

export function formatUnknownVodError(error: unknown): string {
	return formatUnknownError(error);
}