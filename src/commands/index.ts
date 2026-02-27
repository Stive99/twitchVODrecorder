import type { Bot } from 'grammy';
import { createChannelsCommand } from './channels';
import { createHistoryCommand } from './history';
import { createInfoCommand } from './info';
import { createStartCommand } from './start';
import { createStatusCommand } from './status';
import { createStreamsCommand, registerStreamsCallbacks } from './streams';
import type { CommandDependencies } from './types';
import { registerCommands } from './types';
import { createVodCommand } from './vod';

export function setupCommands(bot: Bot, deps: CommandDependencies): void {
	registerCommands(bot, [
		createStartCommand(),
		createVodCommand(deps),
		createStatusCommand(deps),
		createHistoryCommand(),
		createChannelsCommand(deps),
		createInfoCommand(),
		createStreamsCommand()
	]);
	registerStreamsCallbacks(bot);
}