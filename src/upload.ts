import { InputFile, InputMediaBuilder } from 'grammy';
import { bot } from './config';

export interface UploadMetadata {
	streamTitle: string;
	streamDate?: string;
	channel: string;
	channelUrl?: string;
	durationText: string;
	titles: Array<{ title: string; category: string }>;
	vodUrl: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function buildCaption(meta: UploadMetadata): string {
	const lines: string[] = [];

	const safeChannel = escapeHtml(meta.channel);
	const channelHeader = meta.channelUrl
		? `<a href="${escapeHtml(meta.channelUrl)}"><b>${safeChannel}</b></a>`
		: `<b>${safeChannel}</b>`;
	lines.push(`📊 ${channelHeader}`);
	lines.push(`⏱ Длительность: ${escapeHtml(meta.durationText)}`);
	lines.push('');

	if (meta.streamDate) {
		lines.push(`📅 Дата стрима: ${escapeHtml(meta.streamDate)}`);
		lines.push('');
	}

	lines.push('📝 Названия:');
	meta.titles.forEach((item, index) => {
		lines.push(`${index + 1}. ${escapeHtml(item.title)}`);
		lines.push(`🎮 Категория: ${escapeHtml(item.category)}`);
	});

	const base = lines.join('\n');
	return base.length <= 1000 ? base : `${base.slice(0, 997)}...`;
}

function isRequestEntityTooLarge(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return text.includes('413') || text.includes('Request Entity Too Large');
}

export async function uploadChunks(
	dir: string,
	meta: UploadMetadata,
	targetChatId: string | number,
	chunkBaseName: string,
	onProgress?: (uploadedCount: number, totalCount: number) => Promise<void> | void
): Promise<void> {
	const files: string[] = [];
	for await (const name of new Bun.Glob(`${chunkBaseName}_*.mp4`).scan({
		cwd: dir
	})) {
		files.push(`${dir}/${name}`);
	}
	files.sort();

	if (files.length === 0) {
		throw new Error('Chunk files were not generated');
	}

	const caption = buildCaption(meta);
	for (const [index, filePath] of files.entries()) {
		const media = InputMediaBuilder.video(
			new InputFile(filePath),
			index === 0
				? { caption, parse_mode: 'HTML', supports_streaming: true }
				: { supports_streaming: true }
		);
		try {
			await bot.api.sendVideo(targetChatId, media.media, media);
			if (onProgress) {
				await onProgress(index + 1, files.length);
			}
		} catch (error) {
			if (isRequestEntityTooLarge(error)) {
				throw new Error(
					`Chunk is too large for Telegram upload: ${filePath}. Reduce VOD_SEGMENT_SECONDS and retry.`, { cause: error }
				);
			}
			throw error;
		}
	}
}