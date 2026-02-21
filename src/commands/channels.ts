import type { BotCommand, CommandDependencies } from './types';

export function createChannelsCommand(deps: CommandDependencies): BotCommand {
	return {
		name: 'channels',
		description: 'Show chats where bot is active',
		execute: async ctx => {
			await ctx.reply(deps.getKnownChatsText());
		}
	};
}