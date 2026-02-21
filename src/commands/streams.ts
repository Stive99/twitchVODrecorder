import { stat } from 'node:fs/promises';
import {
	readdir,
	rm
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { OWNER_USER_ID } from '../config';
import { getDirectoryHistory } from '../history';
import type { BotCommand } from './types';

const dataDir = resolve(process.env.DATA_DIR ?? '/data/streams');
const callbackPrefix = 'streams:';
const pathTokenStore = new Map<string, string>();
let pathTokenCounter = 0;

type EntryKind = 'dir' | 'file';

interface BrowserEntry {
	name: string;
	kind: EntryKind;
	absolutePath: string;
	sizeBytes?: number;
}

function createPathToken(absolutePath: string): string {
	for (const [token, value] of pathTokenStore) {
		if (value === absolutePath) {
			return token;
		}
	}
	pathTokenCounter += 1;
	const token = pathTokenCounter.toString(36);
	pathTokenStore.set(token, absolutePath);
	if (pathTokenStore.size > 5000) {
		const oldest = pathTokenStore.keys().next().value;
		if (oldest) {
			pathTokenStore.delete(oldest);
		}
	}
	return token;
}

function resolveSafePath(rawPath: string): string {
	const absolute = resolve(rawPath);
	if (absolute !== dataDir && !absolute.startsWith(`${dataDir}${sep}`)) {
		throw new Error('Недопустимый путь');
	}
	return absolute;
}

function getPathFromToken(token: string): string {
	const stored = pathTokenStore.get(token);
	if (!stored) {
		throw new Error('Путь устарел. Обновите список.');
	}
	return resolveSafePath(stored);
}

function getPathFromTokenOrNull(token: string): string | null {
	try {
		return getPathFromToken(token);
	} catch {
		return null;
	}
}

function formatBytes(value: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let idx = 0;
	while (size >= 1024 && idx < units.length - 1) {
		size /= 1024;
		idx += 1;
	}
	return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function statusBadgeForDir(absolutePath: string): string {
	const history = getDirectoryHistory(absolutePath);
	if (!history) {
		return '⚪';
	}
	if (history.status === 'done') {
		return '✅';
	}
	if (history.status === 'error') {
		return '❌';
	}
	return '⏳';
}

async function listDirectory(absolutePath: string): Promise<BrowserEntry[]> {
	const entries = await readdir(absolutePath, { withFileTypes: true });
	const result: BrowserEntry[] = [];
	for (const entry of entries) {
		const childPath = resolveSafePath(resolve(absolutePath, entry.name));
		if (entry.isDirectory()) {
			result.push({
				name: entry.name,
				kind: 'dir',
				absolutePath: childPath
			});
			continue;
		}
		if (entry.isFile()) {
			const stats = await stat(childPath);
			result.push({
				name: entry.name,
				kind: 'file',
				absolutePath: childPath,
				sizeBytes: stats.size
			});
		}
	}
	return result.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === 'dir' ? -1 : 1;
		}
		return a.name.localeCompare(b.name, 'ru');
	});
}

function buildBreadcrumb(absolutePath: string): string {
	if (absolutePath === dataDir) {
		return '/data/streams';
	}
	const relative = absolutePath.slice(dataDir.length).replaceAll('\\', '/');
	return `/data/streams${relative}`;
}

async function buildDirectoryView(absolutePath: string): Promise<{
	text: string;
	keyboard: InlineKeyboard;
}> {
	const entries = await listDirectory(absolutePath);
	const dirCount = entries.filter(item => item.kind === 'dir').length;
	const fileCount = entries.length - dirCount;
	const lines: string[] = [
		`📂 ${buildBreadcrumb(absolutePath)}`,
		`Папок: ${dirCount}, файлов: ${fileCount}`
	];

	const history = getDirectoryHistory(absolutePath);
	if (history) {
		const label =
			history.status === 'done'
				? 'загружено'
				: history.status === 'error'
					? 'ошибка загрузки'
					: 'в процессе';
		lines.push(`Статус папки: ${label}`);
	}

	const keyboard = new InlineKeyboard();
	for (const entry of entries) {
		const token = createPathToken(entry.absolutePath);
		if (entry.kind === 'dir') {
			keyboard.text(
				`${statusBadgeForDir(entry.absolutePath)} 📁 ${entry.name}`,
				`${callbackPrefix}open:${token}`
			);
		} else {
			keyboard.text(
				`📄 ${entry.name} (${formatBytes(entry.sizeBytes ?? 0)})`,
				`${callbackPrefix}file:${token}`
			);
		}
		keyboard.row();
	}

	if (absolutePath !== dataDir) {
		const parentPath = resolveSafePath(resolve(absolutePath, '..'));
		const parentToken = createPathToken(parentPath);
		const dirToken = createPathToken(absolutePath);
		keyboard.text('⬆️ Вверх', `${callbackPrefix}open:${parentToken}`);
		keyboard.text('🗑 Удалить папку', `${callbackPrefix}deldir:${dirToken}`);
		keyboard.row();
	}

	const currentToken = createPathToken(absolutePath);
	keyboard.text('🔄 Обновить', `${callbackPrefix}open:${currentToken}`);
	return {
		text: lines.join('\n'),
		keyboard
	};
}

async function buildFileView(absolutePath: string): Promise<{
	text: string;
	keyboard: InlineKeyboard;
}> {
	const info = await stat(absolutePath);
	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const fileToken = createPathToken(absolutePath);
	const parentToken = createPathToken(parentPath);
	const keyboard = new InlineKeyboard()
		.text('⬅️ К папке', `${callbackPrefix}open:${parentToken}`)
		.text('🗑 Удалить файл', `${callbackPrefix}delfile:${fileToken}`);
	const lines = [
		`📄 ${buildBreadcrumb(absolutePath)}`,
		`Размер: ${formatBytes(info.size)}`,
		`Изменен: ${new Date(info.mtimeMs).toLocaleString('ru-RU')}`
	];
	return { text: lines.join('\n'), keyboard };
}

async function editBrowserMessage(
	ctx: Context,
	text: string,
	keyboard: InlineKeyboard
): Promise<void> {
	try {
		await ctx.editMessageText(text, {
			reply_markup: keyboard
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('message is not modified')) {
			return;
		}
		throw error;
	}
}

export function createStreamsCommand(): BotCommand {
	return {
		name: 'streams',
		description: 'Browse /data/streams',
		execute: async ctx => {
			const view = await buildDirectoryView(dataDir);
			await ctx.reply(view.text, {
				reply_markup: view.keyboard
			});
		}
	};
}

export function registerStreamsCallbacks(bot: Bot): void {
	bot.on('callback_query:data', async ctx => {
		const data = ctx.callbackQuery.data;
		if (!data.startsWith(callbackPrefix)) {
			return;
		}
		if (ctx.from?.id !== OWNER_USER_ID) {
			await ctx.answerCallbackQuery({ text: 'Доступ только владельцу' });
			return;
		}

		const payload = data.slice(callbackPrefix.length);
		const separator = payload.indexOf(':');
		if (separator === -1) {
			await ctx.answerCallbackQuery({ text: 'Некорректный callback' });
			return;
		}

		const action = payload.slice(0, separator);
		const token = payload.slice(separator + 1);
		if (!token) {
			await ctx.answerCallbackQuery({ text: 'Пустой callback token' });
			return;
		}

		try {
			const resolvedPath = getPathFromTokenOrNull(token);
			if (!resolvedPath) {
				const view = await buildDirectoryView(dataDir);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery({ text: 'Список устарел. Открыт корень.' });
				return;
			}

			if (action === 'open') {
				const dirPath = resolvedPath;
				const view = await buildDirectoryView(dirPath);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery();
				return;
			}

			if (action === 'file') {
				const filePath = resolvedPath;
				const view = await buildFileView(filePath);
				await editBrowserMessage(ctx, view.text, view.keyboard);
				await ctx.answerCallbackQuery();
				return;
			}

			if (action === 'delfile') {
				const filePath = resolvedPath;
				const parentPath = resolveSafePath(resolve(filePath, '..'));
				await rm(filePath, { force: true });
				const view = await buildDirectoryView(parentPath);
				await editBrowserMessage(
					ctx,
					`${view.text}\n\n✅ Файл удален: ${filePath.split(/[\\/]/).at(-1) ?? filePath}`,
					view.keyboard
				);
				await ctx.answerCallbackQuery({ text: 'Файл удален' });
				return;
			}

			if (action === 'deldir') {
				const dirPath = resolvedPath;
				if (dirPath === dataDir) {
					await ctx.answerCallbackQuery({
						text: 'Корневую папку удалять нельзя'
					});
					return;
				}
				const parentPath = resolveSafePath(resolve(dirPath, '..'));
				await rm(dirPath, { recursive: true, force: true });
				const view = await buildDirectoryView(parentPath);
				await editBrowserMessage(
					ctx,
					`${view.text}\n\n✅ Папка удалена: ${dirPath.split(/[\\/]/).at(-1) ?? dirPath}`,
					view.keyboard
				);
				await ctx.answerCallbackQuery({ text: 'Папка удалена' });
				return;
			}

			await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			await ctx.answerCallbackQuery({ text: text.slice(0, 180) });
		}
	});
}