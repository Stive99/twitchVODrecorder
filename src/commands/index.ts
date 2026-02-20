import type { Bot } from "grammy";
import { createChannelsCommand } from "./channels";
import { createStartCommand } from "./start";
import { createStatusCommand } from "./status";
import type { CommandDependencies } from "./types";
import { registerCommands } from "./types";
import { createVodCommand } from "./vod";

export function setupCommands(bot: Bot, deps: CommandDependencies): void {
	registerCommands(bot, [
		createStartCommand(),
		createVodCommand(deps),
		createStatusCommand(deps),
		createChannelsCommand(deps),
	]);
}
