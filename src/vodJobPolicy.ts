import {
	estimateSourceBytesPerSecondByProbe,
	resolveSegmentSecondsByBitrate,
	resolveSegmentSecondsBySize
} from './vodJobSlicing';

export interface InitialSlicePlan {
	effectiveSegmentSeconds: number;
	probeBytesPerSecond?: number;
	baseBySizeSegmentSeconds: number;
}

export async function resolveInitialSlicePlan(
	sourceFile: string,
	sourceSizeBytes: number,
	durationSeconds: number | undefined,
	uploadLimitBytes: number
): Promise<InitialSlicePlan> {
	const baseBySizeSegmentSeconds = resolveSegmentSecondsBySize(
		sourceSizeBytes,
		durationSeconds,
		uploadLimitBytes
	);
	const probeBytesPerSecond = await estimateSourceBytesPerSecondByProbe(
		sourceFile,
		durationSeconds
	);
	if (!probeBytesPerSecond) {
		return {
			effectiveSegmentSeconds: baseBySizeSegmentSeconds,
			baseBySizeSegmentSeconds
		};
	}
	const byProbeSegmentSeconds = resolveSegmentSecondsByBitrate(
		probeBytesPerSecond,
		uploadLimitBytes
	);
	return {
		effectiveSegmentSeconds: Math.min(baseBySizeSegmentSeconds, byProbeSegmentSeconds),
		probeBytesPerSecond,
		baseBySizeSegmentSeconds
	};
}