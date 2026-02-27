import type { BotCommand } from './types';

export function createStartCommand(): BotCommand {
	return {
		name: 'start',
		description: 'Start bot and show help',
		execute: async ctx => {
			await ctx.reply(
				[
					'Бот активен.',
					'Команды:',
					'/start - старт и помощь',
					'/vod <url> - скачать и нарезать Twitch VOD',
					'/info <url> - показать metadata для VOD/clip',
					'/status - статус задач',
					'/channels - чаты/каналы, где бот активен',
					'/streams - показать файлы и папки'
				].join('\n')
			);
		}
	};
}