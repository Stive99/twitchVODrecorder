import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { type Bot, type Context } from 'grammy';
import { OWNER_USER_ID } from './config';
import {
	callbackPrefix,
	dataDir,
	getPathFromTokenOrNull,
	resolveSafePath
} from './streamsShared';
import {
	buildDirectoryView,
	buildFileContentView,
	buildFileView,
	editBrowserMessage
} from './streamsViews';
import {
	uploadDirectorySegmentsWithProgress,
	uploadSegmentWithProgress
} from './streamsUploads';

interface ParsedCallbackPayload {
	action: string;
	token: string;
}

function parseCallbackPayload(data: string): ParsedCallbackPayload | null {
	if (!data.startsWith(callbackPrefix)) {
		return null;
	}

	const payload = data.slice(callbackPrefix.length);
	const separator = payload.indexOf(':');
	if (separator === -1) {
		return null;
	}

	const action = payload.slice(0, separator);
	const token = payload.slice(separator + 1);
	if (!token) {
		return null;
	}

	return { action, token };
}

async function showRootView(ctx: Context, noticeText?: string): Promise<void> {
	const view = await buildDirectoryView(dataDir);
	await editBrowserMessage(
		ctx,
		noticeText ? `${view.text}\n\n${noticeText}` : view.text,
		view.keyboard
	);
}

async function deleteFileAndRefresh(ctx: Context, absolutePath: string): Promise<void> {
	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	await rm(absolutePath, { force: true });
	const view = await buildDirectoryView(parentPath);
	await editBrowserMessage(
		ctx,
		`${view.text}\n\n✅ Файл удален: ${basename(absolutePath)}`,
		view.keyboard
	);
	await ctx.answerCallbackQuery({ text: 'Файл удален' });
}

async function deleteDirectoryAndRefresh(ctx: Context, absolutePath: string): Promise<void> {
	if (absolutePath === dataDir) {
		await ctx.answerCallbackQuery({ text: 'Корневую папку удалять нельзя' });
		return;
	}

	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	await rm(absolutePath, { recursive: true, force: true });
	const view = await buildDirectoryView(parentPath);
	await editBrowserMessage(
		ctx,
		`${view.text}\n\n✅ Папка удалена: ${basename(absolutePath)}`,
		view.keyboard
	);
	await ctx.answerCallbackQuery({ text: 'Папка удалена' });
}

async function handleKnownAction(
	ctx: Context,
	action: string,
	resolvedPath: string
): Promise<boolean> {
	switch (action) {
		case 'open': {
			const view = await buildDirectoryView(resolvedPath);
			await editBrowserMessage(ctx, view.text, view.keyboard);
			await ctx.answerCallbackQuery();
			return true;
		}
		case 'file': {
			const view = await buildFileView(resolvedPath);
			await editBrowserMessage(ctx, view.text, view.keyboard);
			await ctx.answerCallbackQuery();
			return true;
		}
		case 'readfile': {
			const view = await buildFileContentView(resolvedPath);
			await editBrowserMessage(ctx, view.text, view.keyboard);
			await ctx.answerCallbackQuery();
			return true;
		}
		case 'uploaddir':
			await ctx.answerCallbackQuery({ text: 'Запускаю загрузку сегментов папки' });
			await uploadDirectorySegmentsWithProgress(ctx, resolvedPath);
			return true;
		case 'uploadseg':
			await ctx.answerCallbackQuery({ text: 'Запускаю загрузку сегмента' });
			await uploadSegmentWithProgress(ctx, resolvedPath);
			return true;
		case 'delfile':
			await deleteFileAndRefresh(ctx, resolvedPath);
			return true;
		case 'deldir':
			await deleteDirectoryAndRefresh(ctx, resolvedPath);
			return true;
		default:
			return false;
	}
}

export function registerStreamsCallbacks(bot: Bot): void {
	bot.on('callback_query:data', async ctx => {
		const parsed = parseCallbackPayload(ctx.callbackQuery.data);
		if (!parsed) {
			if (ctx.callbackQuery.data.startsWith(callbackPrefix)) {
				await ctx.answerCallbackQuery({ text: 'Некорректный callback' });
			}
			return;
		}

		if (ctx.from?.id !== OWNER_USER_ID) {
			await ctx.answerCallbackQuery({ text: 'Доступ только владельцу' });
			return;
		}

		try {
			const resolvedPath = getPathFromTokenOrNull(parsed.token);
			if (!resolvedPath) {
				await showRootView(ctx, 'Список устарел. Открыт корень.');
				await ctx.answerCallbackQuery({ text: 'Список устарел. Открыт корень.' });
				return;
			}

			const handled = await handleKnownAction(ctx, parsed.action, resolvedPath);
			if (!handled) {
				await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
			}
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			try {
				await ctx.answerCallbackQuery({ text: text.slice(0, 180) });
			} catch {
				// Callback may already be answered.
			}
		}
	});
}