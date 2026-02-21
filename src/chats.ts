import type { Chat } from 'grammy/types';

interface KnownChat {
	id: number;
	type: string;
	title: string;
	lastSeenAt: string;
}

const dataDir = process.env.DATA_DIR ?? '/data/streams';
const storagePath = `${dataDir}/known-chats.json`;
const knownChats = new Map<number, KnownChat>();
let initialized = false;

async function saveKnownChats(): Promise<void> {
	const payload = JSON.stringify(Array.from(knownChats.values()), null, 2);
	await Bun.write(storagePath, payload);
}

export async function initKnownChats(): Promise<void> {
	if (initialized) {
		return;
	}
	initialized = true;

	try {
		const file = Bun.file(storagePath);
		if (!(await file.exists())) {
			return;
		}

		const raw = await file.text();
		const parsed = JSON.parse(raw) as KnownChat[];
		for (const chat of parsed) {
			knownChats.set(chat.id, chat);
		}
	} catch {
		return;
	}
}

function chatTitle(
	chat: Pick<Chat, 'id' | 'type'> &
		Partial<Pick<Chat, 'title' | 'username' | 'first_name' | 'last_name'>>
): string {
	if (
		'title' in chat &&
		typeof chat.title === 'string' &&
		chat.title.trim().length > 0
	) {
		return chat.title;
	}

	if (
		'username' in chat &&
		typeof chat.username === 'string' &&
		chat.username.trim().length > 0
	) {
		return `@${chat.username}`;
	}

	if (chat.type === 'private' && 'first_name' in chat) {
		const first =
			typeof chat.first_name === 'string' ? chat.first_name : 'Private';
		const last =
			'last_name' in chat && typeof chat.last_name === 'string'
				? ` ${chat.last_name}`
				: '';
		return `${first}${last}`.trim();
	}

	return `Chat ${chat.id}`;
}

export async function rememberChat(
	chat: Pick<Chat, 'id' | 'type'> &
		Partial<Pick<Chat, 'title' | 'username' | 'first_name' | 'last_name'>>
): Promise<void> {
	const item: KnownChat = {
		id: chat.id,
		type: chat.type,
		title: chatTitle(chat),
		lastSeenAt: new Date().toISOString()
	};

	knownChats.set(chat.id, item);

	try {
		await Bun.$`mkdir -p ${dataDir}`;
		await saveKnownChats();
	} catch {
		return;
	}
}

export function getKnownChatsText(): string {
	const chats = Array.from(knownChats.values()).sort((a, b) => b.id - a.id);
	if (chats.length === 0) {
		return 'Пока нет чатов/каналов в памяти. Добавьте бота в канал или отправьте сообщение.';
	}

	const lines = chats.map(
		chat => `${chat.title} | id=${chat.id} | type=${chat.type}`
	);
	return ['Чаты/каналы бота:', ...lines].join('\n');
}