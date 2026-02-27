import { writeFile } from 'node:fs/promises';
import type { UploadMetadata } from './uploadTypes';
import type { YtInfo } from './vodJobTypes';
import { downloaderBinary, runCommand, vodMetadataFileName } from './vodJobRuntime';
import { buildUploadMetadataFromYtInfo } from './uploadMetadata';

export async function loadVodMetadata(url: string): Promise<UploadMetadata> {
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

	const ytInfo = JSON.parse(stdout) as YtInfo;
	return buildUploadMetadataFromYtInfo(ytInfo, url);
}

export async function saveVodMetadataSnapshot(
	workDir: string,
	metadata: UploadMetadata
): Promise<void> {
	const metadataPath = `${workDir}/${vodMetadataFileName}`;
	await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}