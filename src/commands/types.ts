import type { Bot, Context } from "grammy";

export interface CommandDependencies {
	startVodJob: (
		url: string,
		requestedByChatId: number,
	) => Promise<{ jobId: string }>;
	getStatusText: () => string;
	getKnownChatsText: () => string;
}

export interface BotCommand {
	name: string;
	description: string;
	execute: (ctx: Context, args: string[]) => Promise<void>;
}

function extractArgs(ctx: Context): string[] {
	const text = ctx.msg?.text;
	if (!text) {
		return [];
	}

	const tokens = text.trim().split(/\s+/);
	return tokens.slice(1);
}

export function registerCommands(bot: Bot, commands: BotCommand[]): void {
	for (const command of commands) {
		bot.command(command.name, async (ctx) => {
			await command.execute(ctx, extractArgs(ctx));
		});
	}
}
