FROM oven/bun:1.2.22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages yt-dlp

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data/streams

CMD ["bun", "src/bot.ts"]
