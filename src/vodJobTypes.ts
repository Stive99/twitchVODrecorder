export type JobState =
	| 'queued'
	| 'metadata'
	| 'downloading'
	| 'slicing'
	| 'uploading'
	| 'done'
	| 'error';

export type SliceMode = 'copy' | 'reencode';

export interface VodJob {
	id: string;
	url: string;
	requestedByChatId: number;
	targetChatId: string | number;
	state: JobState;
	progress: number;
	createdAt: number;
	updatedAt: number;
	statusMessageId?: number;
	lastStatusText?: string;
	lastStatusSentAt?: number;
	lastNotifiedState?: JobState;
	lastNotifiedProgress?: number;
	error?: string;
	publishSummary?: string;
}

export interface YtInfo {
	id?: string;
	title?: string;
	fulltitle?: string;
	description?: string;
	channel?: string;
	channel_id?: string;
	channel_url?: string;
	uploader?: string;
	uploader_id?: string;
	uploader_url?: string;
	category?: string;
	game?: string;
	genre?: string;
	duration?: number;
	duration_string?: string;
	categories?: string[];
	chapters?: Array<{
		title?: string;
		category?: string;
		start_time?: number;
		end_time?: number;
	}>;
	timestamp?: number;
	release_timestamp?: number;
	upload_date?: string;
}