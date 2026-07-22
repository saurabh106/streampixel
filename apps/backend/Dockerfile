FROM node:20-alpine AS development
RUN apk add --no-cache git unzip curl
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY apps/backend/package*.json ./apps/backend/
COPY apps/backend/src/projects/signaling/package*.json ./apps/backend/src/projects/signaling/
COPY packages/shared ./packages/shared/
RUN npm install
COPY apps/backend ./apps/backend/
RUN cd apps/backend && npx prisma generate
EXPOSE 5000
CMD ["npm", "run", "dev", "--workspace=apps/backend"]

FROM node:20-alpine AS builder
RUN apk add --no-cache git unzip curl
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/shared ./packages/shared/
COPY apps/backend ./apps/backend/
RUN npm install
RUN npm run build --workspace=packages/shared
RUN cd apps/backend && npx prisma generate && npm run build

FROM node:20-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip curl ca-certificates \
    libvulkan1 vulkan-tools mesa-vulkan-drivers libgl1-mesa-dri libglx-mesa0 xvfb \
    xdg-utils xdg-user-dirs \
    libfontconfig1 libfreetype6 libx11-6 libxcursor1 libxrandr2 libxi6 \
    libxinerama1 libxkbcommon0 libdrm2 libegl1 libgl1-mesa-glx \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
ENV VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
RUN mkdir -p /opt/streampixel/storage/projects /opt/streampixel/storage/tmp && \
    chown -R node:node /opt/streampixel/storage && \
    chmod -R 777 /opt/streampixel/storage
WORKDIR /app
COPY package*.json ./
COPY apps/backend/package*.json ./apps/backend/
COPY apps/backend/src/projects/signaling/package*.json ./apps/backend/src/projects/signaling/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install --omit=dev --ignore-scripts
RUN npm rebuild bcrypt
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/apps/backend/prisma ./apps/backend/prisma
COPY --from=builder /app/apps/backend/src/projects/signaling ./apps/backend/src/projects/signaling
RUN npx prisma generate --schema=./apps/backend/prisma/schema.prisma
RUN chown -R node:node /app /opt/streampixel/storage
USER node
EXPOSE 5000
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./apps/backend/prisma/schema.prisma && node apps/backend/dist/main"]
