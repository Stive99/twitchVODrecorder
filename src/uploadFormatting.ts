import type { UploadMetadata } from './uploadTypes';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function buildUploadCaption(meta: UploadMetadata): string {
	const lines: string[] = [];

	const safeChannel = escapeHtml(meta.channel);
	const channelHeader = meta.channelUrl
		? `<a href="${escapeHtml(meta.channelUrl)}"><b>${safeChannel}</b></a>`
		: `<b>${safeChannel}</b>`;
	lines.push(`📺 ${channelHeader}`);
	lines.push(`🕒 Длительность: ${escapeHtml(meta.durationText)}`);
	lines.push('');

	if (meta.streamDate) {
		lines.push(`📅 Дата стрима: ${escapeHtml(meta.streamDate)}`);
		lines.push('');
	}

	const uniqueTitles: string[] = [];
	const uniqueCategories: string[] = [];
	for (const item of meta.titles) {
		if (!uniqueTitles.includes(item.title)) {
			uniqueTitles.push(item.title);
		}
		if (!uniqueCategories.includes(item.category)) {
			uniqueCategories.push(item.category);
		}
	}

	const firstTitle = uniqueTitles[0];
	if (uniqueTitles.length === 1 && firstTitle) {
		lines.push(`🎬 Название: ${escapeHtml(firstTitle)}`);
	} else {
		lines.push('🎬 Названия:');
		uniqueTitles.forEach((title, index) => {
			lines.push(`${index + 1}. ${escapeHtml(title)}`);
		});
	}

	lines.push('');

	const firstCategory = uniqueCategories[0];
	if (uniqueCategories.length === 1 && firstCategory) {
		lines.push(`📂 Категория: ${escapeHtml(firstCategory)}`);
	} else {
		lines.push('📂 Категории:');
		uniqueCategories.forEach((category, index) => {
			lines.push(`${index + 1}. ${escapeHtml(category)}`);
		});
	}

	const base = lines.join('\n');
	return base.length <= 1000 ? base : `${base.slice(0, 997)}...`;
}

export function buildFinalPostText(
	meta: UploadMetadata,
	totalFiles: number,
	totalBytes: number
): string {
	const lines: string[] = [];
	lines.push('<b>Публикация завершена</b>');
	lines.push('');
	lines.push(`Название: <b>${escapeHtml(meta.streamTitle)}</b>`);
	lines.push(`Канал: ${escapeHtml(meta.channel)}`);
	lines.push(`Длительность: ${escapeHtml(meta.durationText)}`);
	if (meta.streamDate) {
		lines.push(`Дата: ${escapeHtml(meta.streamDate)}`);
	}
	lines.push(`Файлов: ${totalFiles}`);
	lines.push(`Размер: ${Math.floor(totalBytes / (1024 * 1024))} MB`);
	lines.push('');
	lines.push(`VOD: ${escapeHtml(meta.vodUrl)}`);
	return lines.join('\n');
}