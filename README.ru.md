# Twitch VOD Recorder Bot

<p align="right">
	<a href="./README.md">EN English</a> |
	<a href="./README.ru.md">RU Русский</a><br/>
</p>

Telegram-бот для скачивания Twitch VOD/клипов, нарезки видео на части и загрузки результатов в Telegram.

## Обзор

Проект работает по простому сценарию:

1. Вы отправляете Twitch-ссылку боту.
2. Бот скачивает медиа через `yt-dlp`.
3. Бот режет файл через `ffmpeg`.
4. Бот загружает части в Telegram.

Управление ботом доступно только владельцу (`TELEGRAM_OWNER_ID`).

## Возможности

- Поддержка Twitch VOD и clip ссылок
- Управление через команды (`/vod`, `/status` и т.д.)
- Автопоиск Twitch URL в обычных сообщениях
- Последовательная in-memory очередь задач
- Уведомления о прогрессе в Telegram
- Опциональная отправка в целевой канал через `TELEGRAM_CHANNEL_ID`

## Технологии

- Runtime: `Bun`
- Язык: `TypeScript`
- Telegram library: `grammy`
- Downloader: `yt-dlp`
- Video processing: `ffmpeg`

## Требования

- Bun
- ffmpeg
- yt-dlp (или `ytdl` в PATH)
- Telegram bot token от BotFather

## Быстрый старт

1. Установите зависимости:

```bash
bun install
```

2. Создайте `.env` из шаблона:

```bash
cp .env.example .env
```

Для PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Заполните обязательные переменные в `.env`.

4. Запустите бота:

```bash
bun run start
```

Режим разработки (watch):

```bash
bun run dev
```

## Переменные окружения

| Переменная | Обязательна | Описание |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Да | Токен Telegram-бота |
| `TELEGRAM_OWNER_ID` | Да | Telegram user ID, которому разрешено управлять ботом |
| `TELEGRAM_CHANNEL_ID` | Нет | Целевой чат/канал для загрузок; если пусто, используется чат запроса |
| `DATA_DIR` | Нет | Рабочая директория для медиафайлов (по умолчанию: `/data/streams`) |
| `VOD_SEGMENT_SECONDS` | Нет | Длина сегмента в секундах (по умолчанию: `2400`) |
| `YTDLP_BIN` | Нет | Имя/путь к бинарнику downloader |
| `BOT_API_ROOT` | Нет | Кастомный endpoint Telegram Bot API |
| `BOT_API_RETRY_MAX_ATTEMPTS` | Нет | Количество повторов Telegram API при временных ошибках (по умолчанию: `4`) |
| `BOT_API_MAX_CONCURRENT` | Нет | Максимум одновременных запросов к Telegram API в throttler (по умолчанию: `8`) |
| `BOT_RATE_LIMIT_WINDOW_MS` | Нет | Окно rate-limit для запросов пользователя в миллисекундах (по умолчанию: `60000`) |
| `BOT_RATE_LIMIT_REQUESTS` | Нет | Максимум запросов за окно для пользователя/чата (по умолчанию: `5`) |

## Команды бота

- `/start` - показать справку
- `/vod <url>` - добавить VOD/clip в очередь
- `/status` - показать статус последних задач
- `/channels` - показать известные чаты/каналы

Бот также анализирует обычные текстовые сообщения на наличие Twitch URL.

## Docker

Сборка и запуск через Docker Compose:

```bash
docker compose up -d --build
```

Остановка:

```bash
docker compose down
```

Поведение контейнера:

- Устанавливает `ffmpeg`, `python3` и `yt-dlp`
- Запускает бота через `bun src/bot.ts`
- Хранит медиа в Docker volume `streams_data`, смонтированном в `/data/streams`

## Скрипты

- `bun run start` - запуск бота
- `bun run dev` - запуск с отслеживанием изменений
- `bun run lint` - проверка кода
- `bun run lint:fix` - автоисправление lint

## Примечания

- Очередь in-memory: история задач сбрасывается после перезапуска процесса.
- Бот ориентирован на Twitch VOD/clip ссылки.
