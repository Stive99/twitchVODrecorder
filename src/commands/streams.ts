import type { Bot } from 'grammy';
import { registerStreamsCallbacks as registerStreamsCallbackHandlers } from '../streamsCallbacks';
import { dataDir } from '../streamsShared';
import { buildDirectoryView } from '../streamsViews';
import type { BotCommand } from './types';

export function createStreamsCommand(): BotCommand {
	return {
		name: 'streams',
		description: 'Browse /data/streams',
		execute: async ctx => {
			const view = await buildDirectoryView(dataDir);
			await ctx.reply(view.text, { reply_markup: view.keyboard });
		}
	};
}

export function registerStreamsCallbacks(bot: Bot): void {
	registerStreamsCallbackHandlers(bot);
}