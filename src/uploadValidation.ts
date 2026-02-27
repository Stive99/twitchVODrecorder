import { stat } from 'node:fs/promises';
import { logger } from './logger';
import { ChunkTooLargeError, formatUnknownError } from './uploadErrors';
import type { NormalizedUploadFile, UploadFileDescriptor, UploadMetadata } from './uploadTypes';

const log = logger.init('upload');

export function validateUploadMetadata(meta: UploadMetadata): void {
	if (!meta.streamTitle?.trim()) {
		throw new Error('Upload metadata streamTitle is empty');
	}
	if (!meta.channel?.trim()) {
		throw new Error('Upload metadata channel is empty');
	}
	if (!meta.durationText?.trim()) {
		throw new Error('Upload metadata durationText is empty');
	}
	if (!meta.vodUrl?.trim()) {
		throw new Error('Upload metadata vodUrl is empty');
	}
	if (!Array.isArray(meta.titles) || meta.titles.length === 0) {
		throw new Error('Upload metadata titles are empty');
	}
}

export function normalizeTargetChatId(targetChatId: string | number): string | number {
	if (typeof targetChatId === 'number') {
		if (!Number.isFinite(targetChatId)) {
			throw new Error('Target chat id is not finite');
		}
		return targetChatId;
	}
	const normalized = targetChatId.trim();
	if (!normalized) {
		throw new Error('Target chat id is empty');
	}
	return normalized;
}

export async function prepareUploadFiles(
	filesInput: UploadFileDescriptor[],
	maxUploadBytes: number
): Promise<{ files: NormalizedUploadFile[]; totalBytes: number }> {
	const seenPaths = new Set<string>();
	const files: NormalizedUploadFile[] = [];
	let totalBytes = 0;

	for (const file of filesInput) {
		const filePath = file.path?.trim();
		if (!filePath) {
			throw new Error('Upload file path is empty');
		}
		if (seenPaths.has(filePath)) {
			throw new Error(`Duplicate upload file path: ${filePath}`);
		}
		seenPaths.add(filePath);

		let info;
		try {
			info = await stat(filePath);
		} catch (error) {
			throw new Error(
				`Upload file is not accessible: ${filePath} (${formatUnknownError(error)})`,
				{ cause: error }
			);
		}
		if (!info.isFile()) {
			throw new Error(`Upload path is not a file: ${filePath}`);
		}
		if (info.size <= 0) {
			throw new Error(`Upload file is empty: ${filePath}`);
		}

		if (file.sizeBytes !== info.size) {
			log.warn('Upload descriptor size differs from actual file size, actual size will be used', {
				filePath,
				descriptorSizeBytes: file.sizeBytes,
				actualSizeBytes: info.size
			});
		}
		if (info.size > maxUploadBytes) {
			throw new ChunkTooLargeError(filePath, info.size);
		}

		files.push({ path: filePath, sizeBytes: info.size });
		totalBytes += info.size;
	}

	return { files, totalBytes };
}