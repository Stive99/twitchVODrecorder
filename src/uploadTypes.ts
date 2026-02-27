export interface UploadMetadata {
	streamTitle: string;
	streamDate?: string;
	channel: string;
	channelUrl?: string;
	durationText: string;
	titles: Array<{ title: string; category: string }>;
	vodUrl: string;
}

export interface UploadProgress {
	uploadedBytes: number;
	totalBytes: number;
	uploadedFiles: number;
	totalFiles: number;
}

export interface UploadFileDescriptor {
	path: string;
	sizeBytes: number;
}

export interface NormalizedUploadFile {
	path: string;
	sizeBytes: number;
}

export interface UploadTelemetryHooks {
	onRetry?: (context: { stage: 'single' | 'group' | 'post'; attempt: number }) => void;
	onEntityTooLarge?: (context: { stage: 'single' | 'group' }) => void;
}