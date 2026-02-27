export class ChunkTooLargeError extends Error {
	filePath: string;
	sizeBytes?: number;

	constructor(filePath: string, sizeBytes?: number, options?: ErrorOptions) {
		super(
			`Chunk is too large for Telegram upload: ${filePath}. Reduce segment duration and retry.`,
			options
		);
		this.name = 'ChunkTooLargeError';
		this.filePath = filePath;
		this.sizeBytes = sizeBytes;
	}
}

export function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function isRequestEntityTooLarge(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return text.includes('413') || text.includes('Request Entity Too Large');
}