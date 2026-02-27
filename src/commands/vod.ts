import type { BotCommand, CommandDependencies } from './types';

function createStartGate(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

export function createVodCommand(deps: CommandDependencies): BotCommand {
	return {
		name: 'vod',
		description: 'Download VOD by URL',
		execute: async (ctx, args) => {
			const url = args[0]?.trim();
			if (!url) {
				await ctx.reply('Использование: /vod <twitch_vod_url>');
				return;
			}

			if (!ctx.chat) {
				await ctx.reply('Не удалось определить чат для запуска задачи');
				return;
			}

			const startGate = createStartGate();
			const job = await deps.startVodJob(url, ctx.chat.id, {
				startAfter: startGate.promise
			});
			try {
				await ctx.reply(
					[
						`🎬 Задача создана: ${job.jobId}`
					].join('\n')
				);
			} finally {
				startGate.release();
			}
		}
	};
}