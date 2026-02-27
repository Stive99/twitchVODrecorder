const DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_STANDARD = 45;
const DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_LOCAL = 2000;
const DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_STANDARD = 0.9;
const DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_LOCAL = 0.95;

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
	mode: 'standard' | 'local';
	apiRoot?: string;
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

function isLikelyLocalBotApiRoot(apiRoot: string | undefined): boolean {
	if (!apiRoot) {
		return false;
	}
	try {
		const host = new URL(apiRoot).hostname.toLowerCase();
		if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
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

function resolveDefaultLimitMb(): number {
	const apiRoot = resolveApiRoot();
	return isLikelyLocalBotApiRoot(apiRoot)
		? DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_LOCAL
		: DEFAULT_TELEGRAM_UPLOAD_LIMIT_MB_STANDARD;
}

function resolveDefaultSafetyRatio(): number {
	const apiRoot = resolveApiRoot();
	return isLikelyLocalBotApiRoot(apiRoot)
		? DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_LOCAL
		: DEFAULT_TELEGRAM_UPLOAD_SAFETY_RATIO_STANDARD;
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
	const apiRoot = resolveApiRoot();
	const mode = isLikelyLocalBotApiRoot(apiRoot) ? 'local' : 'standard';
	const configuredLimitBytes = resolveTelegramUploadLimitBytes();
	const effectiveLimitBytes = resolveTelegramEffectiveUploadLimitBytes();
	const safetyRatio = configuredLimitBytes > 0
		? effectiveLimitBytes / configuredLimitBytes
		: resolveDefaultSafetyRatio();

	return {
		mode,
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