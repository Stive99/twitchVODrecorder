import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { logger } from './logger';

const log = logger.init('history');
const dataDir = process.env.DATA_DIR ?? '/data/streams';
const historyDbPath =
	process.env.SQLITE_DB_PATH?.trim() || join(dataDir, '.state', 'history.sqlite');

export type UploadHistoryStatus =
	| 'queued'
	| 'metadata'
	| 'downloading'
	| 'slicing'
	| 'uploading'
	| 'done'
	| 'error';

interface CreateUploadHistoryParams {
	jobId: string;
	requestedByChatId: number;
	targetChatId: string | number;
	vodUrl: string;
}

interface UpdateUploadContextParams {
	workDir?: string;
	streamTitle?: string;
}

interface RawUploadHistoryRow {
	job_id: string;
	work_dir: string | null;
	stream_title: string | null;
	status: UploadHistoryStatus;
	error_text: string | null;
	updated_at: number;
	completed_at: number | null;
}

export interface UploadHistoryRow {
	jobId: string;
	workDir?: string;
	streamTitle?: string;
	status: UploadHistoryStatus;
	errorText?: string;
	updatedAt: number;
	completedAt?: number;
}

const db = (() => {
	mkdirSync(dirname(historyDbPath), { recursive: true });
	const instance = new Database(historyDbPath, { create: true });
	instance.exec(`
		CREATE TABLE IF NOT EXISTS upload_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id TEXT NOT NULL UNIQUE,
			requested_by_chat_id INTEGER NOT NULL,
			target_chat_id TEXT NOT NULL,
			vod_url TEXT NOT NULL,
			work_dir TEXT,
			stream_title TEXT,
			status TEXT NOT NULL,
			error_text TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_upload_history_work_dir
			ON upload_history(work_dir);
		CREATE INDEX IF NOT EXISTS idx_upload_history_status
			ON upload_history(status);
		CREATE INDEX IF NOT EXISTS idx_upload_history_updated_at
			ON upload_history(updated_at DESC);
	`);
	return instance;
})();

log.info('SQLite history ready', { historyDbPath });

const insertUploadStmt = db.prepare(
	`INSERT INTO upload_history
		(job_id, requested_by_chat_id, target_chat_id, vod_url, status, created_at, updated_at)
	VALUES ($jobId, $requestedByChatId, $targetChatId, $vodUrl, 'queued', $now, $now)
	ON CONFLICT(job_id) DO UPDATE SET
		requested_by_chat_id = excluded.requested_by_chat_id,
		target_chat_id = excluded.target_chat_id,
		vod_url = excluded.vod_url,
		status = excluded.status,
		error_text = NULL,
		updated_at = excluded.updated_at,
		completed_at = NULL`
);

const updateUploadContextStmt = db.prepare(
	`UPDATE upload_history
		SET work_dir = COALESCE($workDir, work_dir),
			stream_title = COALESCE($streamTitle, stream_title),
			updated_at = $now
		WHERE job_id = $jobId`
);

const updateUploadStatusStmt = db.prepare(
	`UPDATE upload_history
		SET status = $status,
			error_text = $errorText,
			updated_at = $now,
			completed_at = CASE
				WHEN $status IN ('done', 'error') THEN $now
				ELSE completed_at
			END
		WHERE job_id = $jobId`
);

const selectLatestByWorkDirStmt = db.prepare(
	`SELECT
		job_id,
		work_dir,
		stream_title,
		status,
		error_text,
		updated_at,
		completed_at
	FROM upload_history
	WHERE work_dir = $workDir
	ORDER BY updated_at DESC
	LIMIT 1`
);

const selectRecentStmt = db.prepare(
	`SELECT
		job_id,
		work_dir,
		stream_title,
		status,
		error_text,
		updated_at,
		completed_at
	FROM upload_history
	ORDER BY updated_at DESC
	LIMIT $limit`
);

function nowMs(): number {
	return Date.now();
}

function toUploadHistoryRow(row: RawUploadHistoryRow): UploadHistoryRow {
	return {
		jobId: row.job_id,
		workDir: row.work_dir ?? undefined,
		streamTitle: row.stream_title ?? undefined,
		status: row.status,
		errorText: row.error_text ?? undefined,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? undefined
	};
}

export function createUploadHistoryEntry(
	params: CreateUploadHistoryParams
): void {
	insertUploadStmt.run({
		$jobId: params.jobId,
		$requestedByChatId: params.requestedByChatId,
		$targetChatId: String(params.targetChatId),
		$vodUrl: params.vodUrl,
		$now: nowMs()
	});
}

export function updateUploadHistoryContext(
	jobId: string,
	params: UpdateUploadContextParams
): void {
	updateUploadContextStmt.run({
		$jobId: jobId,
		$workDir: params.workDir ?? null,
		$streamTitle: params.streamTitle ?? null,
		$now: nowMs()
	});
}

export function updateUploadHistoryStatus(
	jobId: string,
	status: UploadHistoryStatus,
	errorText?: string
): void {
	updateUploadStatusStmt.run({
		$jobId: jobId,
		$status: status,
		$errorText: errorText ?? null,
		$now: nowMs()
	});
}

export function getDirectoryHistory(workDir: string): UploadHistoryRow | null {
	const row = selectLatestByWorkDirStmt.get({
		$workDir: workDir
	}) as RawUploadHistoryRow | null;
	if (!row) {
		return null;
	}
	return toUploadHistoryRow(row);
}

export function getRecentUploadHistory(limit = 20): UploadHistoryRow[] {
	const rows = selectRecentStmt.all({
		$limit: Math.max(1, Math.min(limit, 100))
	}) as RawUploadHistoryRow[];
	return rows.map(toUploadHistoryRow);
}