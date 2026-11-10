FROM node:22-bookworm-slim

# Debian's ffmpeg ships libx264, aac and libass (the `subtitles` filter). fontconfig + a font are needed for burned-in captions.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
