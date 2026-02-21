import { limit } from '@grammyjs/ratelimiter';
import { run } from '@grammyjs/runner';
import type { Context } from 'grammy';
import { getKnownChatsText, initKnownChats, rememberChat } from './chats';
import { setupCommands } from './commands';
import { bot, DEFAULT_TARGET_CHAT_ID, OWNER_USER_ID } from './config';
import { logger } from './logger';
import { runStartupPreflight } from './preflight';
import { enqueueVod, extractVodUrl, getStatusText } from './vod';

const log = logger.init('bot');

try {
	await runStartupPreflight(bot, DEFAULT_TARGET_CHAT_ID);
} catch (error) {
	log.error('Startup preflight failed', {
		error: error instanceof Error ? error.message : String(error)
	});
	process.exit(1);
}

await initKnownChats();
await rememberConfiguredTargetChat();

async function rememberConfiguredTargetChat(): Promise<void> {
	if (!DEFAULT_TARGET_CHAT_ID) {
		return;
	}
	try {
		const chat = await bot.api.getChat(DEFAULT_TARGET_CHAT_ID);
		await rememberChat(chat);
		log.info('Configured target chat is accessible', {
			targetChatId: DEFAULT_TARGET_CHAT_ID,
			type: chat.type
		});
	} catch (error) {
		log.warn('Configured target chat is not accessible', {
			targetChatId: DEFAULT_TARGET_CHAT_ID,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

function createStartGate(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
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

const requestWindowMs = parsePositiveInt(
	process.env.BOT_RATE_LIMIT_WINDOW_MS,
	60000
);
const requestLimitPerWindow = parsePositiveInt(
	process.env.BOT_RATE_LIMIT_REQUESTS,
	5
);

const textRateLimiter = limit<Context, never>({
	timeFrame: requestWindowMs,
	limit: requestLimitPerWindow,
	keyGenerator: ctx => {
		const userId = ctx.from?.id;
		if (userId) {
			return `${userId}`;
		}
		return `${ctx.chat?.id ?? 'unknown'}`;
	},
	onLimitExceeded: async ctx => {
		if (ctx.chat?.type === 'private') {
			await ctx.reply('Слишком много запросов. Повторите немного позже.');
		}
	}
});

bot.use(async (ctx, next) => {
	if (!ctx.msg?.text || ctx.chat?.type !== 'private') {
		await next();
		return;
	}
	if (ctx.from?.id === OWNER_USER_ID) {
		await next();
		return;
	}
	await textRateLimiter(ctx, next);
});

bot.use(async (ctx, next) => {
	const text = ctx.msg?.text;
	if (!text) {
		await next();
		return;
	}

	if (ctx.chat?.type !== 'private') {
		if (ctx.update.channel_post) {
			await next();
		}
		return;
	}

	if (ctx.from?.id !== OWNER_USER_ID) {
		await ctx.reply('Управление ботом доступно только владельцу.');
		return;
	}

	await next();
});

setupCommands(bot, {
	startVodJob: async (
		url: string,
		requestedByChatId: number,
		options?: { startAfter?: Promise<unknown> }
	) => enqueueVod(url, requestedByChatId, options),
	getStatusText,
	getKnownChatsText
});

bot.catch(error => {
	log.error('Bot error', { error: error.error });
});

bot.on('message:text', async ctx => {
	if (ctx.chat) {
		await rememberChat(ctx.chat);
	}
	if (ctx.chat?.type !== 'private') {
		return;
	}

	if (ctx.msg.text.startsWith('/')) {
		return;
	}

	const vodUrl = extractVodUrl(ctx.msg.text);
	if (!vodUrl || !ctx.chat) {
		return;
	}

	const startGate = createStartGate();
	const job = enqueueVod(vodUrl, ctx.chat.id, {
		startAfter: startGate.promise
	});
	try {
		await ctx.reply(
			[
				`🎬 VOD добавлен в очередь: ${job.jobId}`,
				'Статус будет обновляться в одном сообщении.'
			].join('\n')
		);
	} finally {
		startGate.release();
	}
});

bot.on('channel_post:text', async ctx => {
	if (ctx.chat) {
		await rememberChat(ctx.chat);
	}
});

await bot.api.setMyCommands([
	{ command: 'start', description: 'Старт и помощь' },
	{ command: 'vod', description: 'Скачать VOD по ссылке' },
	{ command: 'status', description: 'Статус задач' },
	{ command: 'history', description: 'История загрузок из SQLite' },
	{ command: 'channels', description: 'Список каналов' },
	{ command: 'streams', description: 'Файлы и папки /data/streams' }
]);

const runner = run(bot);

const shutdown = (signal: NodeJS.Signals): void => {
	log.warn('Shutdown signal received', { signal });
	runner.stop();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

log.info('Bot started with runner', {
	rateLimitWindowMs: requestWindowMs,
	rateLimitRequests: requestLimitPerWindow
});