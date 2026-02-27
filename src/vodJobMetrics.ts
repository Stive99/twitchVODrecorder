import { logger } from './logger';

const log = logger.init('vod-metrics');
const alertMinJobs = Number.parseInt(process.env.VOD_METRICS_ALERT_MIN_JOBS ?? '5', 10);
const alertFailRateThreshold = Number.parseFloat(process.env.VOD_METRICS_ALERT_FAIL_RATE ?? '0.3');
const alert413Threshold = Number.parseInt(process.env.VOD_METRICS_ALERT_413 ?? '3', 10);

interface AggregateMetrics {
	jobsTotal: number;
	jobsFailed: number;
	entityTooLargeTotal: number;
}

const aggregate: AggregateMetrics = {
	jobsTotal: 0,
	jobsFailed: 0,
	entityTooLargeTotal: 0
};

function nowMs(): number {
	return Date.now();
}

export class VodJobMetrics {
	private readonly jobId: string;
	private readonly startedAtMs: number;
	private readonly stageStartedAt = new Map<string, number>();
	private readonly stageDurationsMs = new Map<string, number>();
	private uploadRetryCount = 0;
	private sliceRetryCount = 0;
	private entityTooLargeCount = 0;
	private chunksTotalSizeBytes = 0;
	private chunksTotalCount = 0;

	constructor(jobId: string) {
		this.jobId = jobId;
		this.startedAtMs = nowMs();
	}

	startStage(stage: string): void {
		this.stageStartedAt.set(stage, nowMs());
	}

	endStage(stage: string): void {
		const startedAt = this.stageStartedAt.get(stage);
		if (!startedAt) {
			return;
		}
		const elapsed = Math.max(0, nowMs() - startedAt);
		const prev = this.stageDurationsMs.get(stage) ?? 0;
		this.stageDurationsMs.set(stage, prev + elapsed);
		this.stageStartedAt.delete(stage);
	}

	recordSliceRetry(): void {
		this.sliceRetryCount += 1;
	}

	recordUploadRetry(): void {
		this.uploadRetryCount += 1;
	}

	recordEntityTooLarge(): void {
		this.entityTooLargeCount += 1;
	}

	recordChunkStats(chunkCount: number, totalSizeBytes: number): void {
		if (chunkCount <= 0 || totalSizeBytes <= 0) {
			return;
		}
		this.chunksTotalCount += chunkCount;
		this.chunksTotalSizeBytes += totalSizeBytes;
	}

	finalize(success: boolean): void {
		for (const stage of Array.from(this.stageStartedAt.keys())) {
			this.endStage(stage);
		}
		aggregate.jobsTotal += 1;
		if (!success) {
			aggregate.jobsFailed += 1;
		}
		aggregate.entityTooLargeTotal += this.entityTooLargeCount;

		const failRate = aggregate.jobsTotal > 0 ? aggregate.jobsFailed / aggregate.jobsTotal : 0;
		const averageChunkBytes =
			this.chunksTotalCount > 0 ? Math.floor(this.chunksTotalSizeBytes / this.chunksTotalCount) : 0;

		log.info('VOD job metrics', {
			jobId: this.jobId,
			success,
			totalElapsedMs: nowMs() - this.startedAtMs,
			stageDurationsMs: Object.fromEntries(this.stageDurationsMs.entries()),
			uploadRetryCount: this.uploadRetryCount,
			sliceRetryCount: this.sliceRetryCount,
			entityTooLargeCount: this.entityTooLargeCount,
			averageChunkBytes,
			chunksObserved: this.chunksTotalCount,
			aggregateJobsTotal: aggregate.jobsTotal,
			aggregateJobsFailed: aggregate.jobsFailed,
			aggregateFailRate: Number(failRate.toFixed(4)),
			aggregateEntityTooLargeTotal: aggregate.entityTooLargeTotal
		});

		const normalizedAlertMinJobs =
			Number.isFinite(alertMinJobs) && alertMinJobs > 0 ? alertMinJobs : 5;
		const normalizedFailRateThreshold =
			Number.isFinite(alertFailRateThreshold) && alertFailRateThreshold > 0
				? alertFailRateThreshold
				: 0.3;
		const normalized413Threshold =
			Number.isFinite(alert413Threshold) && alert413Threshold > 0
				? alert413Threshold
				: 3;

		if (
			aggregate.jobsTotal >= normalizedAlertMinJobs &&
			failRate >= normalizedFailRateThreshold
		) {
			log.warn('VOD fail-rate alert threshold reached', {
				aggregateJobsTotal: aggregate.jobsTotal,
				aggregateJobsFailed: aggregate.jobsFailed,
				aggregateFailRate: Number(failRate.toFixed(4)),
				threshold: normalizedFailRateThreshold
			});
		}

		if (this.entityTooLargeCount >= normalized413Threshold) {
			log.warn('VOD 413 alert threshold reached', {
				jobId: this.jobId,
				entityTooLargeCount: this.entityTooLargeCount,
				threshold: normalized413Threshold
			});
		}
	}
}