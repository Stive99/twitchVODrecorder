import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import dotenv from 'dotenv';
import { Bot } from 'grammy';
import { logger } from './logger';
import { requireLocalBotApiRoot } from './uploadConfig';

dotenv.config();

const apiRoot = requireLocalBotApiRoot();

if (!process.env.TELEGRAM_BOT_TOKEN) {
	logger.error('TELEGRAM_BOT_TOKEN is not set in environment variables');
	throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
}

if (!process.env.TELEGRAM_OWNER_ID) {
	logger.error('TELEGRAM_OWNER_ID is not set in environment variables');
	throw new Error('TELEGRAM_OWNER_ID is not set in environment variables');
}

const ownerUserId = Number.parseInt(process.env.TELEGRAM_OWNER_ID, 10);
if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
	logger.error('TELEGRAM_OWNER_ID must be a positive integer');
	throw new Error('TELEGRAM_OWNER_ID must be a positive integer');
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

const retryMaxAttempts = parsePositiveInt(
	process.env.BOT_API_RETRY_MAX_ATTEMPTS,
	4
);
const throttlerMaxConcurrent = parsePositiveInt(
	process.env.BOT_API_MAX_CONCURRENT,
	8
);

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
	client: { apiRoot }
});
bot.api.config.use(
	autoRetry({
		maxRetryAttempts: retryMaxAttempts
	})
);
bot.api.config.use(
	apiThrottler({
		out: { maxConcurrent: throttlerMaxConcurrent }
	})
);

export const OWNER_USER_ID = ownerUserId;
export const DEFAULT_TARGET_CHAT_ID = process.env.TELEGRAM_CHANNEL_ID?.trim() || undefined;