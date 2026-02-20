import type { BotCommand } from "./types";

export function createStartCommand(): BotCommand {
	return {
		name: "start",
		description: "Start bot and show help",
		execute: async (ctx) => {
			await ctx.reply(
				[
					"Бот активен.",
					"Команды:",
					"/start - старт и помощь",
					"/vod <url> - скачать и нарезать Twitch VOD",
					"/status - статус задач",
					"/channels - чаты/каналы, где бот активен",
				].join("\n"),
			);
		},
	};
}
