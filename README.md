# Twitch VOD Recorder Bot

<p align="right">
	<a href="./README.md">EN English</a> |
	<a href="./README.ru.md">RU Русский</a><br/>
</p>

A Telegram bot that downloads Twitch VODs/clips, splits video into chunks, and uploads results to Telegram.

## Overview

This project is designed for a simple workflow:

1. Send a Twitch URL to the bot.
2. Bot downloads media with `yt-dlp`.
3. Bot splits the file with `ffmpeg`.
4. Bot uploads chunks to Telegram.

The bot accepts control commands only from the owner (`TELEGRAM_OWNER_ID`).

## Features

- Twitch VOD and clip URL support
- Command-based control (`/vod`, `/status`, etc.)
- Auto-detect Twitch URLs in regular text messages
- Sequential in-memory queue processing
- Progress notifications to Telegram chat
- Optional target channel forwarding via `TELEGRAM_CHANNEL_ID`

## Tech Stack

- Runtime: `Bun`
- Language: `TypeScript`
- Telegram library: `grammy`
- Downloader: `yt-dlp`
- Video processing: `ffmpeg`

## Requirements

- Bun
- ffmpeg
- yt-dlp (or `ytdl` in PATH)
- Telegram bot token from BotFather

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Create `.env` from template:

```bash
cp .env.example .env
```

PowerShell alternative:

```powershell
Copy-Item .env.example .env
```

3. Fill required environment variables in `.env`.

4. Run bot:

```bash
bun run start
```

Development mode (watch):

```bash
bun run dev
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_OWNER_ID` | Yes | Telegram user ID allowed to control the bot |
| `TELEGRAM_CHANNEL_ID` | No | Target chat/channel for uploads; if empty, uses request chat |
| `DATA_DIR` | No | Working directory for media files (default: `/data/streams`) |
| `VOD_SEGMENT_SECONDS` | No | Segment length in seconds (default: `2400`) |
| `YTDLP_BIN` | No | Downloader binary name/path |
| `BOT_API_ROOT` | No | Custom Telegram Bot API endpoint |
| `BOT_API_RETRY_MAX_ATTEMPTS` | No | Telegram API retry attempts for transient errors (default: `4`) |
| `BOT_API_MAX_CONCURRENT` | No | Max concurrent Telegram API calls in throttler (default: `8`) |
| `BOT_RATE_LIMIT_WINDOW_MS` | No | User request rate-limit window in milliseconds (default: `60000`) |
| `BOT_RATE_LIMIT_REQUESTS` | No | Max requests per window per user/chat (default: `5`) |

## Bot Commands

- `/start` - show help
- `/vod <url>` - enqueue VOD/clip download
- `/status` - show recent jobs status
- `/channels` - show known chats/channels

The bot also scans regular text messages for Twitch URLs.

## Docker

Build and run with Docker Compose:

```bash
docker compose up -d --build
```

Stop:

```bash
docker compose down
```

Container behavior:

- Installs `ffmpeg`, `python3`, and `yt-dlp`
- Runs bot with `bun src/bot.ts`
- Persists media in Docker volume `streams_data` mapped to `/data/streams`

## Scripts

- `bun run start` - run bot
- `bun run dev` - run with file watching
- `bun run lint` - lint source files
- `bun run lint:fix` - lint with auto-fix

## Notes

- Queue is in memory; job history is reset on process restart.
- This bot is focused on Twitch VOD/clip links.
