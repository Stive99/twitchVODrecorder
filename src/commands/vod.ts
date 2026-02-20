import type { BotCommand, CommandDependencies } from "./types";

export function createVodCommand(deps: CommandDependencies): BotCommand {
	return {
		name: "vod",
		description: "Download VOD by URL",
		execute: async (ctx, args) => {
			const url = args[0]?.trim();
			if (!url) {
				await ctx.reply("Использование: /vod <twitch_vod_url>");
				return;
			}

			if (!ctx.chat) {
				await ctx.reply("Не удалось определить чат для запуска задачи");
				return;
			}

			const job = await deps.startVodJob(url, ctx.chat.id);
			await ctx.reply(`Задача принята: ${job.jobId}`);
		},
	};
}
