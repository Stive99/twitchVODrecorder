import type { UploadMetadata } from './uploadTypes';

const tvIcon = '\u{1F4FA}';
const clockIcon = '\u{1F552}';
const calendarIcon = '\u{1F4C5}';
const titleIcon = '\u{1F3AC}';
const categoryIcon = '\u{1F4C2}';
const publishDoneText = '\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430';
const durationLabel = '\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C';
const streamDateLabel = '\u0414\u0430\u0442\u0430 \u0441\u0442\u0440\u0438\u043C\u0430';
const titleLabel = '\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435';
const titlesLabel = '\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u044F';
const categoryLabel = '\u041A\u0430\u0442\u0435\u0433\u043E\u0440\u0438\u044F';
const categoriesLabel = '\u041A\u0430\u0442\u0435\u0433\u043E\u0440\u0438\u0438';
const channelLabel = '\u041A\u0430\u043D\u0430\u043B';
const dateLabel = '\u0414\u0430\u0442\u0430';
const filesLabel = '\u0424\u0430\u0439\u043B\u043E\u0432';
const sizeLabel = '\u0420\u0430\u0437\u043C\u0435\u0440';

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
	lines.push(`${tvIcon} ${channelHeader}`);
	lines.push(`${clockIcon} ${durationLabel}: ${escapeHtml(meta.durationText)}`);

	if (meta.streamDate) {
		lines.push(`${calendarIcon} ${streamDateLabel}: ${escapeHtml(meta.streamDate)}`);
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
		lines.push(`${titleIcon} ${titleLabel}: ${escapeHtml(firstTitle)}`);
	} else {
		lines.push(`${titleIcon} ${titlesLabel}:`);
		uniqueTitles.forEach((title, index) => {
			lines.push(`${index + 1}. ${escapeHtml(title)}`);
		});
	}

	const firstCategory = uniqueCategories[0];
	if (uniqueCategories.length === 1 && firstCategory) {
		lines.push(`${categoryIcon} ${categoryLabel}: ${escapeHtml(firstCategory)}`);
	} else {
		lines.push(`${categoryIcon} ${categoriesLabel}:`);
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
	lines.push(`<b>${publishDoneText}</b>`);
	lines.push('');
	lines.push(`${titleLabel}: <b>${escapeHtml(meta.streamTitle)}</b>`);
	lines.push(`${channelLabel}: ${escapeHtml(meta.channel)}`);
	lines.push(`${durationLabel}: ${escapeHtml(meta.durationText)}`);
	if (meta.streamDate) {
		lines.push(`${dateLabel}: ${escapeHtml(meta.streamDate)}`);
	}
	lines.push(`${filesLabel}: ${totalFiles}`);
	lines.push(`${sizeLabel}: ${Math.floor(totalBytes / (1024 * 1024))} MB`);
	lines.push('');
	lines.push(`VOD: ${escapeHtml(meta.vodUrl)}`);
	return lines.join('\n');
}