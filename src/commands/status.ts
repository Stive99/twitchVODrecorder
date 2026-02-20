import type { BotCommand, CommandDependencies } from "./types";

export function createStatusCommand(deps: CommandDependencies): BotCommand {
	return {
		name: "status",
		description: "Show active and recent jobs",
		execute: async (ctx) => {
			await ctx.reply(deps.getStatusText());
		},
	};
}
