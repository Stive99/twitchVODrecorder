import { loadVodMetadata } from '../vodJobMetadata';
import { buildUploadCaption } from '../uploadFormatting';
import { extractVodUrl } from '../vodJobUtils';
import type { BotCommand } from './types';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

export function createInfoCommand(): BotCommand {
	return {
		name: 'info',
		description: 'Show VOD/clip metadata',
		execute: async (ctx, args) => {
			const rawInput = args.join(' ').trim();
			const url = extractVodUrl(rawInput);
			if (!url) {
				await ctx.reply('Usage: /info <twitch_vod_or_clip_url>');
				return;
			}

			try {
				const metadata = await loadVodMetadata(url);
				await ctx.reply(
					`<b>vod-metadata.json</b>\n<pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>`,
					{ parse_mode: 'HTML' }
				);
				await ctx.reply(`<b>Post preview</b>\n${buildUploadCaption(metadata)}`, {
					parse_mode: 'HTML',
					link_preview_options: { is_disabled: true }
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.reply(`Failed to load metadata: ${message}`);
			}
		}
	};
}