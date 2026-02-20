import { getKnownChatsText, initKnownChats, rememberChat } from "./chats";
import { setupCommands } from "./commands";
import { bot, OWNER_USER_ID } from "./config";
import { logger } from "./logger";
import { enqueueVod, extractVodUrl, getStatusText } from "./vod";

const log = logger.init("bot");

await initKnownChats();

bot.use(async (ctx, next) => {
	const text = ctx.msg?.text;
	if (!text) {
		await next();
		return;
	}

	if (ctx.from?.id !== OWNER_USER_ID) {
		await ctx.reply("Управление ботом доступно только владельцу.");
		return;
	}

	await next();
});

setupCommands(bot, {
	startVodJob: async (url: string, requestedByChatId: number) =>
		enqueueVod(url, requestedByChatId),
	getStatusText,
	getKnownChatsText,
});

bot.catch((error) => {
	log.error("Bot error", { error: error.error });
});

bot.on("message:text", async (ctx) => {
	if (ctx.chat) {
		await rememberChat(ctx.chat);
	}

	if (ctx.msg.text.startsWith("/")) {
		return;
	}

	const vodUrl = extractVodUrl(ctx.msg.text);
	if (!vodUrl || !ctx.chat) {
		return;
	}

	const job = enqueueVod(vodUrl, ctx.chat.id);
	await ctx.reply(`VOD принят в обработку: ${job.jobId}`);
});

bot.on("channel_post:text", async (ctx) => {
	if (ctx.chat) {
		await rememberChat(ctx.chat);
	}
});

await bot.api.setMyCommands([
	{ command: "start", description: "Старт и помощь" },
	{ command: "vod", description: "Скачать VOD по ссылке" },
	{ command: "status", description: "Статус задач" },
	{ command: "channels", description: "Список каналов" },
]);

bot.start();
log.info("Bot started");
