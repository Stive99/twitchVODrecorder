import { spawn } from 'bun';
import { progressWithinStage, setStateAndNotify } from './vodJobStatus';
import type { VodJob } from './vodJobTypes';
import { trimOutput } from './vodJobUtils';
import { downloaderBinary, readStreamLines, withHeavyTaskLimit } from './vodJobRuntime';

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

export async function downloadVodWithProgress(
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
	await withHeavyTaskLimit(async () => {
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
	});
}