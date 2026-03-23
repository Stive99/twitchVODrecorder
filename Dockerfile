FROM oven/bun:1.3.11

WORKDIR /app

ENV TZ=Europe/Moscow

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip tzdata \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && pip3 install --no-cache-dir --disable-pip-version-check --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data/streams

CMD ["bun", "src/bot.ts"]
