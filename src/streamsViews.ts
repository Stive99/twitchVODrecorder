import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { InlineKeyboard, type Context } from 'grammy';
import { getDirectoryHistory } from './history';
import {
	buildBreadcrumb,
	callbackPrefix,
	collectUploadableSegments,
	createPathToken,
	dataDir,
	formatBytes,
	isUploadableSegmentPath,
	listDirectory,
	previewByteLimit,
	previewTextLimit,
	resolveSafePath,
	statusBadgeForDir
} from './streamsShared';

function buildDirectoryStatusText(absolutePath: string): string | null {
	const history = getDirectoryHistory(absolutePath);
	if (!history) {
		return null;
	}

	const label =
		history.status === 'done'
			? 'загрузки завершены'
			: history.status === 'error'
				? 'ошибка загрузки'
				: 'в процессе';
	return `Статус папки: ${label}`;
}

async function readFilePreviewBytes(absolutePath: string, sizeBytes: number): Promise<Buffer> {
	const bytesToRead = Math.min(sizeBytes, previewByteLimit);
	const handle = await open(absolutePath, 'r');
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function isLikelyBinary(buffer: Buffer): boolean {
	if (buffer.length === 0) {
		return false;
	}

	let suspiciousBytes = 0;
	for (const value of buffer) {
		if (value === 0) {
			return true;
		}
		if (value < 7 || (value > 13 && value < 32)) {
			suspiciousBytes += 1;
		}
	}

	return suspiciousBytes / buffer.length > 0.1;
}

function truncatePreviewText(content: string): { text: string; truncated: boolean } {
	if (content.length <= previewTextLimit) {
		return { text: content, truncated: false };
	}

	return {
		text: `${content.slice(0, previewTextLimit)}\n...`,
		truncated: true
	};
}

export async function buildDirectoryView(
	absolutePath: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
	const entries = await listDirectory(absolutePath);
	const dirCount = entries.filter(item => item.kind === 'dir').length;
	const fileCount = entries.length - dirCount;
	const lines = [`📂 ${buildBreadcrumb(absolutePath)}`, `Папок: ${dirCount}, файлов: ${fileCount}`];
	const statusText = buildDirectoryStatusText(absolutePath);
	if (statusText) {
		lines.push(statusText);
	}

	const keyboard = new InlineKeyboard();
	for (const entry of entries) {
		const token = createPathToken(entry.absolutePath);
		if (entry.kind === 'dir') {
			keyboard.text(`${statusBadgeForDir(entry.absolutePath)} 📁 ${entry.name}`, `${callbackPrefix}open:${token}`);
			keyboard.row();
			continue;
		}
		keyboard.text(`📄 ${entry.name} (${formatBytes(entry.sizeBytes ?? 0)})`, `${callbackPrefix}file:${token}`);
		keyboard.row();
	}

	const dirToken = createPathToken(absolutePath);
	const uploadableSegments = collectUploadableSegments(entries);
	if (uploadableSegments.length > 0) {
		keyboard.text(`⬆️ Загрузить сегменты (${uploadableSegments.length})`, `${callbackPrefix}uploaddir:${dirToken}`);
		keyboard.row();
	}

	if (absolutePath !== dataDir) {
		const parentPath = resolveSafePath(resolve(absolutePath, '..'));
		const parentToken = createPathToken(parentPath);
		keyboard.text('↩️ Назад', `${callbackPrefix}open:${parentToken}`);
		keyboard.text('🗑 Удалить папку', `${callbackPrefix}deldir:${dirToken}`);
		keyboard.row();
	}

	keyboard.text('🔄 Обновить', `${callbackPrefix}open:${dirToken}`);
	return { text: lines.join('\n'), keyboard };
}

export async function buildFileView(
	absolutePath: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
	const info = await stat(absolutePath);
	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const fileToken = createPathToken(absolutePath);
	const parentToken = createPathToken(parentPath);
	const keyboard = new InlineKeyboard()
		.text('↩️ В папку', `${callbackPrefix}open:${parentToken}`)
		.text('🗑 Удалить файл', `${callbackPrefix}delfile:${fileToken}`);

	keyboard.row();
	keyboard.text('👁 Читать файл', `${callbackPrefix}readfile:${fileToken}`);

	if (isUploadableSegmentPath(absolutePath)) {
		keyboard.row();
		keyboard.text('⬆️ Загрузить сегмент', `${callbackPrefix}uploadseg:${fileToken}`);
	}

	return {
		text: [
			`📄 ${buildBreadcrumb(absolutePath)}`,
			`Размер: ${formatBytes(info.size)}`,
			`Изменен: ${new Date(info.mtimeMs).toLocaleString('ru-RU')}`
		].join('\n'),
		keyboard
	};
}

export async function buildFileContentView(
	absolutePath: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
	const info = await stat(absolutePath);
	if (!info.isFile()) {
		throw new Error('Просмотр содержимого доступен только для файла');
	}

	const previewBytes = await readFilePreviewBytes(absolutePath, info.size);
	if (isLikelyBinary(previewBytes)) {
		throw new Error('Предпросмотр доступен только для текстовых файлов');
	}

	let decoded: string;
	try {
		decoded = new TextDecoder('utf-8', { fatal: true }).decode(previewBytes);
	} catch {
		throw new Error('Не удалось прочитать файл как UTF-8 текст');
	}

	const normalized = decoded.replaceAll('\r\n', '\n');
	const preview = truncatePreviewText(normalized);
	const parentPath = resolveSafePath(resolve(absolutePath, '..'));
	const fileToken = createPathToken(absolutePath);
	const parentToken = createPathToken(parentPath);
	const keyboard = new InlineKeyboard()
		.text('↩️ К файлу', `${callbackPrefix}file:${fileToken}`)
		.text('📁 В папку', `${callbackPrefix}open:${parentToken}`);

	const lines = [`📖 ${buildBreadcrumb(absolutePath)}`, `Размер: ${formatBytes(info.size)}`, ''];
	if (normalized.length === 0) {
		lines.push('(пустой файл)');
	} else {
		lines.push(preview.text);
	}

	if (info.size > previewByteLimit || preview.truncated) {
		lines.push('', `Показано только начало файла (${formatBytes(previewBytes.length)}).`);
	}

	return { text: lines.join('\n'), keyboard };
}

export async function editBrowserMessage(
	ctx: Context,
	text: string,
	keyboard: InlineKeyboard
): Promise<void> {
	try {
		await ctx.editMessageText(text, { reply_markup: keyboard });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('message is not modified')) {
			return;
		}
		throw error;
	}
}