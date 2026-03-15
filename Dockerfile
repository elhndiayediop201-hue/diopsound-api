FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

RUN yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

# --max-old-space-size=256 limite la RAM à 256MB
# --expose-gc permet le garbage collection manuel
CMD ["node", "--max-old-space-size=256", "--expose-gc", "server.js"]
