import type { BotCommand } from './types';

export function createWatchCommand(): BotCommand {
	return {
		name: 'watch',
		description: 'Deprecated command',
		execute: async ctx => {
			await ctx.reply(
				'Команда /watch отключена. Используйте ссылку на VOD или /vod <url>.'
			);
		}
	};
}