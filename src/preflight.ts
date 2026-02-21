import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Bot } from 'grammy';
import { logger } from './logger';

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
		// Support absolute/relative paths passed via env var.
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

	// Verify bot token and API availability early.
	await bot.api.getMe();

	const dataDir = resolveDataDir();
	await assertDirectoryWritable(dataDir);

	const sqliteDbPath = resolveSqliteDbPath(dataDir);
	await assertDirectoryWritable(dirname(sqliteDbPath));

	// Check temp directory write access because Bun/FFmpeg may rely on it.
	await assertDirectoryWritable(tmpdir());

	await assertExecutableAvailable('yt-dlp', [
		process.env.YTDLP_BIN?.trim() || '',
		'ytdl',
		'yt-dlp'
	]);
	await assertExecutableAvailable('ffmpeg', ['ffmpeg']);

	assertPositiveNumberEnv('VOD_SEGMENT_SECONDS');
	assertPositiveNumberEnv('BOT_RATE_LIMIT_WINDOW_MS');
	assertPositiveNumberEnv('BOT_RATE_LIMIT_REQUESTS');

	if (targetChatId?.trim()) {
		await bot.api.getChat(targetChatId.trim());
	}

	log.info('Startup checks passed', {
		dataDir,
		sqliteDbPath,
		targetChatId: targetChatId?.trim() || 'not set'
	});
}