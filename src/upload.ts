import { InputFile, InputMediaBuilder } from "grammy";
import { bot } from "./config";

export interface UploadMetadata {
	streamDate?: string;
	channel: string;
	channelUrl?: string;
	durationText: string;
	titles: Array<{ title: string; category: string }>;
	vodUrl: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function buildCaption(meta: UploadMetadata): string {
	const lines: string[] = [];

	const safeChannel = escapeHtml(meta.channel);
	const channelHeader = meta.channelUrl
		? `<a href="${escapeHtml(meta.channelUrl)}"><b>${safeChannel}</b></a>`
		: `<b>${safeChannel}</b>`;
	lines.push(`📊 ${channelHeader}`);
	lines.push(`⏱ Длительность: ${escapeHtml(meta.durationText)}`);
	lines.push("");

	if (meta.streamDate) {
		lines.push(`📅 Дата стрима: ${escapeHtml(meta.streamDate)}`);
		lines.push("");
	}

	lines.push("📝 Названия:");
	meta.titles.forEach((item, index) => {
		lines.push(`${index + 1}. ${escapeHtml(item.title)}`);
		lines.push(`🎮 Категория: ${escapeHtml(item.category)}`);
	});

	const base = lines.join("\n");
	return base.length <= 1000 ? base : `${base.slice(0, 997)}...`;
}

export async function uploadChunks(
	dir: string,
	meta: UploadMetadata,
	targetChatId: string | number,
): Promise<void> {
	const files: string[] = [];
	for await (const name of new Bun.Glob("chunk_*.mp4").scan({ cwd: dir })) {
		files.push(`${dir}/${name}`);
	}
	files.sort();

	if (files.length === 0) {
		throw new Error("Chunk files were not generated");
	}

	const caption = buildCaption(meta);
	const media = files.map((filePath, index) =>
		InputMediaBuilder.video(
			new InputFile(filePath),
			index === 0
				? { caption, parse_mode: "HTML", supports_streaming: true }
				: { supports_streaming: true },
		),
	);

	await bot.api.sendMediaGroup(targetChatId, media);
}
