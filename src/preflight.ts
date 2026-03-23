import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Bot } from 'grammy';
import { logger } from './logger';
import { requireLocalBotApiRoot, resolveUploadLimitDiagnostics } from './uploadConfig';

const log = logger.init('preflight');

function resolveDataDir(): string {
	return process.env.DATA_DIR ?? '/data/streams';
}

function resolveSqliteDbPath(dataDir: string): string {
	return process.env.SQLITE_DB_PATH?.trim() || join(dataDir, '.state', 'history.sqlite');
}

async function assertDirectoryWritable(dirPath: string): Promise<void> {
	await mkdir(dirPath, { recursive: true });
	const probePath = join(
		dirPath,
		`.write-check-${Date.now()}-${Math.floor(Math.random() * 100000)}.tmp`
	);
	await writeFile(probePath, 'ok', 'utf8');
	await rm(probePath, { force: true });
}

async function assertExecutableAvailable(
	name: string,
	candidates: string[]
): Promise<string> {
	for (const candidate of candidates) {
		if (!candidate.trim()) {
			continue;
		}
		if (Bun.which(candidate)) {
			return candidate;
		}
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// continue
		}
	}
	throw new Error(`${name} is not available. Checked: ${candidates.join(', ')}`);
}

function assertPositiveNumberEnv(name: string): void {
	const value = process.env[name]?.trim();
	if (!value) {
		return;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number. Received: ${value}`);
	}
}

export async function runStartupPreflight(
	bot: Bot,
	targetChatId?: string
): Promise<void> {
	log.info('Running startup checks');

	const apiRoot = requireLocalBotApiRoot();
	const uploadLimitDiagnostics = resolveUploadLimitDiagnostics();

	await bot.api.getMe();

	const dataDir = resolveDataDir();
	await assertDirectoryWritable(dataDir);

	const sqliteDbPath = resolveSqliteDbPath(dataDir);
	await assertDirectoryWritable(dirname(sqliteDbPath));

	await assertDirectoryWritable(tmpdir());

	await assertExecutableAvailable('yt-dlp', [
		process.env.YTDLP_BIN?.trim() || '',
		'ytdl',
		'yt-dlp'
	]);
	await assertExecutableAvailable('ffmpeg', ['ffmpeg']);
	await assertExecutableAvailable('ffprobe', ['ffprobe']);

	assertPositiveNumberEnv('VOD_SEGMENT_SECONDS');
	assertPositiveNumberEnv('BOT_API_RETRY_MAX_ATTEMPTS');
	assertPositiveNumberEnv('BOT_API_MAX_CONCURRENT');
	assertPositiveNumberEnv('BOT_RATE_LIMIT_WINDOW_MS');
	assertPositiveNumberEnv('BOT_RATE_LIMIT_REQUESTS');
	assertPositiveNumberEnv('TELEGRAM_UPLOAD_LIMIT_MB');

	if (targetChatId?.trim()) {
		await bot.api.getChat(targetChatId.trim());
	}

	log.info('Startup checks passed', {
		apiRoot,
		dataDir,
		sqliteDbPath,
		targetChatId: targetChatId?.trim() || 'not set',
		uploadLimitDiagnostics
	});
}