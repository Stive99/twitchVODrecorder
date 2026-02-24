import { getRecentUploadHistory } from '../history';
import type { BotCommand } from './types';

function formatTs(value?: number): string {
	if (!value) {
		return '-';
	}
	return new Date(value).toLocaleString('ru-RU');
}

function parseLimit(rawArg?: string): number {
	if (!rawArg) {
		return 10;
	}
	const parsed = Number.parseInt(rawArg, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return 10;
	}
	return Math.max(1, Math.min(parsed, 30));
}

function shorten(value: string, max = 160): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - 3)}...`;
}

export function createHistoryCommand(): BotCommand {
	return {
		name: 'history',
		description: 'Показать историю из SQLite',
		execute: async (ctx, args) => {
			const limit = parseLimit(args[0]);
			const rows = getRecentUploadHistory(limit);

			if (rows.length === 0) {
				await ctx.reply('История пуста.');
				return;
			}

			const lines = rows.map((row, index) => {
				const title = row.streamTitle?.trim() || row.jobId;
				const errorText = row.errorText
					? ` | Ошибка: ${shorten(row.errorText)}`
					: '';
				return `${index + 1}. [${row.status}] ${title}\nОбновлено: ${formatTs(row.updatedAt)} | Завершено: ${formatTs(row.completedAt)}${errorText}`;
			});

			await ctx.reply(['История загрузок:', ...lines].join('\n\n'));
		}
	};
}