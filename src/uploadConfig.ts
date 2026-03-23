const DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_LOCAL = 2000;
const DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_LOCAL = 0.95;
const LOCAL_BOT_API_HOSTNAMES = new Set(['botapi', 'localhost', '127.0.0.1', '::1']);

export const uploadRetryAttempts = 4;
export const uploadRetryBaseDelayMs = 1500;
export const uploadRetryMaxDelayMs = 30000;
export const uploadHeartbeatIntervalMs = 2000;
export const uploadHeartbeatWindowMs = 45000;
export const useMediaGroupUpload = true;
export const mediaGroupMaxSize = 10;
export const postRetryAttempts = 4;
export const postSendDelayMs = resolvePostSendDelayMs();
export const sendFinalPostAfterUpload = process.env.TELEGRAM_SEND_FINAL_POST !== '0';

export interface UploadLimitDiagnostics {
	mode: 'local';
	apiRoot: string;
	configuredLimitMb: number;
	effectiveLimitMb: number;
	configuredLimitBytes: number;
	effectiveLimitBytes: number;
	safetyRatio: number;
}

function resolveApiRoot(): string | undefined {
	const value = process.env.BOT_API_ROOT?.trim();
	return value && value.length > 0 ? value : undefined;
}

export function isLikelyLocalBotApiRoot(apiRoot: string | undefined): boolean {
	if (!apiRoot) {
		return false;
	}
	try {
		const host = new URL(apiRoot).hostname.toLowerCase();
		if (LOCAL_BOT_API_HOSTNAMES.has(host)) {
			return true;
		}
		if (host.startsWith('10.')) {
			return true;
		}
		if (host.startsWith('192.168.')) {
			return true;
		}
		const match = host.match(/^172\.(\d{1,2})\./);
		if (match?.[1]) {
			const second = Number.parseInt(match[1], 10);
			if (Number.isFinite(second) && second >= 16 && second <= 31) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

export function requireLocalBotApiRoot(): string {
	const apiRoot = resolveApiRoot();
	if (!apiRoot) {
		throw new Error(
			'BOT_API_ROOT is required. This bot only supports Local Bot API. Use http://localhost:8081 on host or http://botapi:8081 in docker-compose.'
		);
	}
	if (!isLikelyLocalBotApiRoot(apiRoot)) {
		throw new Error(
			`BOT_API_ROOT must point to a Local Bot API endpoint. Received: ${apiRoot}`
		);
	}
	return apiRoot;
}

function resolveDefaultLimitMb(): number {
	requireLocalBotApiRoot();
	return DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_LOCAL;
}

function resolveDefaultSafetyRatio(): number {
	requireLocalBotApiRoot();
	return DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_LOCAL;
}

export function resolveTelegramUploadLimitBytes(): number {
	const defaultLimitMb = resolveDefaultLimitMb();
	const raw = process.env.TELEGRAM_UPLOAD_LIMIT_MB?.trim();
	if (!raw) {
		return Math.floor(defaultLimitMb * 1024 * 1024);
	}
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return Math.floor(defaultLimitMb * 1024 * 1024);
	}
	return Math.floor(parsed * 1024 * 1024);
}

export function resolveTelegramEffectiveUploadLimitBytes(): number {
	const defaultRatio = resolveDefaultSafetyRatio();
	const rawRatio = process.env.TELEGRAM_UPLOAD_SAFETY_RATIO?.trim();
	const ratio = rawRatio ? Number.parseFloat(rawRatio) : defaultRatio;
	const normalizedRatio =
		Number.isFinite(ratio) && ratio > 0 && ratio <= 1
			? ratio
			: defaultRatio;
	return Math.max(
		1,
		Math.floor(resolveTelegramUploadLimitBytes() * normalizedRatio)
	);
}

export function resolveUploadLimitDiagnostics(): UploadLimitDiagnostics {
	const apiRoot = requireLocalBotApiRoot();
	const configuredLimitBytes = resolveTelegramUploadLimitBytes();
	const effectiveLimitBytes = resolveTelegramEffectiveUploadLimitBytes();
	const safetyRatio = configuredLimitBytes > 0
		? effectiveLimitBytes / configuredLimitBytes
		: resolveDefaultSafetyRatio();

	return {
		mode: 'local',
		apiRoot,
		configuredLimitMb: configuredLimitBytes / (1024 * 1024),
		effectiveLimitMb: effectiveLimitBytes / (1024 * 1024),
		configuredLimitBytes,
		effectiveLimitBytes,
		safetyRatio
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function resolvePostSendDelayMs(): number {
	const raw = process.env.TELEGRAM_POST_DELAY_MS?.trim();
	if (!raw) {
		return 2500;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return 2500;
	}
	return parsed;
}