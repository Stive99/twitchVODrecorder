type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown> | undefined;

const levelWeight: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const levelStyles: Record<LogLevel, { label: string; color: string }> = {
	debug: { label: 'DEBUG', color: '\x1b[36m' },
	info: { label: 'INFO ', color: '\x1b[32m' },
	warn: { label: 'WARN ', color: '\x1b[33m' },
	error: { label: 'ERROR', color: '\x1b[31m' }
};

const resetColor = '\x1b[0m';

function resolveMinLevel(): LogLevel {
	const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
	if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
		return raw;
	}
	return 'info';
}

const minLevel = resolveMinLevel();

function formatTime(date: Date): string {
	return date.toISOString().replace('T', ' ').slice(0, 19);
}

function stringifyMeta(meta: LogMeta): string {
	if (!meta) {
		return '';
	}

	try {
		return ` ${JSON.stringify(meta)}`;
	} catch {
		return ' [unserializable-meta]';
	}
}

export class Logger {
	constructor(private readonly context?: string) {}

	init(context: string): Logger {
		return new Logger(context);
	}

	debug(message: string, meta?: LogMeta): void {
		this.write('debug', message, meta);
	}

	info(message: string, meta?: LogMeta): void {
		this.write('info', message, meta);
	}

	warn(message: string, meta?: LogMeta): void {
		this.write('warn', message, meta);
	}

	error(message: string, meta?: LogMeta): void {
		this.write('error', message, meta);
	}

	private write(level: LogLevel, message: string, meta?: LogMeta): void {
		if (levelWeight[level] < levelWeight[minLevel]) {
			return;
		}

		const style = levelStyles[level];
		const time = formatTime(new Date());
		const scope = this.context ? ` [${this.context}]` : '';
		const text = `${style.color}${style.label}${resetColor} ${time}${scope} ${message}${stringifyMeta(meta)}`;

		if (level === 'error') {
			console.error(text);
			return;
		}
		if (level === 'warn') {
			console.warn(text);
			return;
		}
		console.log(text);
	}
}

export const logger = new Logger('app');