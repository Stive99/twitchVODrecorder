import type { UploadMetadata } from './uploadTypes';
import type { YtInfo } from './vodJobTypes';
import {
	formatStreamDate,
	resolveChannelName,
	resolveChannelUrl,
	resolveDurationSeconds,
	resolveStreamCategories,
	resolveStreamTitles,
	toHms
} from './vodJobUtils';

export function buildUploadMetadataFromYtInfo(
	ytInfo: YtInfo,
	url: string
): UploadMetadata {
	const durationSeconds = resolveDurationSeconds(ytInfo);
	const categories = resolveStreamCategories(ytInfo);
	const titles = resolveStreamTitles(ytInfo, categories);
	const primaryCategory = categories[0] ?? 'Unknown';
	const streamTitle = titles[0] ?? `VOD ${ytInfo.id ?? Date.now()}`;
	const metadataItems = Array.from(
		{ length: Math.max(titles.length, categories.length, 1) },
		(_, index) => ({
			title: titles[index] ?? streamTitle,
			category: categories[index] ?? primaryCategory
		})
	);

	return {
		streamTitle,
		streamDate: formatStreamDate(ytInfo),
		channel: resolveChannelName(ytInfo),
		channelUrl: resolveChannelUrl(ytInfo),
		durationText:
			typeof durationSeconds === 'number' ? toHms(durationSeconds) : 'Unknown',
		titles: metadataItems,
		vodUrl: url
	};
}

export function createFallbackUploadMetadata(
	streamTitle: string,
	vodUrl = 'https://twitch.tv/'
): UploadMetadata {
	return {
		streamTitle,
		streamDate: undefined,
		channel: 'Unknown',
		channelUrl: undefined,
		durationText: 'Unknown',
		titles: [{ title: streamTitle, category: 'Unknown' }],
		vodUrl
	};
}

export function isUploadMetadata(value: unknown): value is UploadMetadata {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const data = value as Partial<UploadMetadata>;
	if (typeof data.streamTitle !== 'string') {
		return false;
	}
	if (typeof data.channel !== 'string') {
		return false;
	}
	if (typeof data.durationText !== 'string') {
		return false;
	}
	if (typeof data.vodUrl !== 'string') {
		return false;
	}
	if (!Array.isArray(data.titles)) {
		return false;
	}
	return data.titles.every(item => {
		if (!item || typeof item !== 'object') {
			return false;
		}
		const titleItem = item as { title?: unknown; category?: unknown };
		return typeof titleItem.title === 'string' && typeof titleItem.category === 'string';
	});
}