import dotenv from "dotenv";
import { Bot } from "grammy";
import { logger } from "./logger";

dotenv.config();

const apiRoot = process.env.BOT_API_ROOT?.trim() || undefined;

if (!process.env.TELEGRAM_BOT_TOKEN) {
	logger.error("TELEGRAM_BOT_TOKEN is not set in environment variables");
	throw new Error("TELEGRAM_BOT_TOKEN is not set in environment variables");
}

if (!process.env.TELEGRAM_OWNER_ID) {
	logger.error("TELEGRAM_OWNER_ID is not set in environment variables");
	throw new Error("TELEGRAM_OWNER_ID is not set in environment variables");
}

const ownerUserId = Number.parseInt(process.env.TELEGRAM_OWNER_ID, 10);
if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
	logger.error("TELEGRAM_OWNER_ID must be a positive integer");
	throw new Error("TELEGRAM_OWNER_ID must be a positive integer");
}

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
	client: apiRoot ? { apiRoot } : undefined,
});

export const OWNER_USER_ID = ownerUserId;
export const DEFAULT_TARGET_CHAT_ID = process.env.TELEGRAM_CHANNEL_ID;
