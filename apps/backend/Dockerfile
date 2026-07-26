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
COPY packages/shared/package*.json ./packages/shared/
COPY apps/backend/src/projects/signaling/package*.json ./apps/backend/src/projects/signaling/
RUN npm install
COPY packages/shared ./packages/shared/
RUN npm run build --workspace=packages/shared
COPY apps/backend/package*.json ./apps/backend/
RUN npm install
COPY apps/backend ./apps/backend/
RUN cd apps/backend && npx prisma generate && npm run build

FROM node:20-slim AS production

# Step 1: Install all base packages from bookworm (stable) — guaranteed to resolve
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip curl ca-certificates \
    xvfb xauth \
    xdg-utils xdg-user-dirs \
    libfontconfig1 libfreetype6 \
    libx11-6 libx11-xcb1 libxcursor1 libxrandr2 libxi6 libxinerama1 \
    libxkbcommon0 libxkbcommon-x11-0 \
    libxcb1 libxcb-keysyms1 libxcb-render0 libxcb-shape0 \
    libxcb-randr0 libxcb-image0 libxcb-util1 \
    libdrm2 libegl1 \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
    libsm6 libice6 gcc libc-dev \
    && rm -rf /var/lib/apt/lists/*

# Step 2: Pull ONLY Mesa/Vulkan packages from Debian sid (rolling, latest).
# These replace the old bookworm versions (Mesa 22.3) with latest (Mesa 25.x)
# which supports Vulkan 1.3+ needed by UE 5.5, 5.6 and beyond.
RUN echo "deb http://deb.debian.org/debian sid main" > /etc/apt/sources.list.d/sid.list && \
    apt-get update && apt-get install -y -t sid --no-install-recommends \
    libvulkan1 vulkan-tools \
    mesa-vulkan-drivers \
    swiftshader || true && \
    apt-get install -y -t sid --no-install-recommends \
    libgl1 libgl1-mesa-dri libglx-mesa0 libegl-mesa0 \
    libglapi-mesa libgbm1 libdrm2 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/sid.list

# Verify Vulkan ICD was installed (SwiftShader or Mesa lavapipe)
RUN VK_ICD=$(find /usr/share/vulkan/icd.d -name '*.json' 2>/dev/null | head -1) && \
    if [ -n "$VK_ICD" ]; then echo "Vulkan ICD found: $VK_ICD"; else echo "WARNING: Vulkan ICD not found!"; fi

ENV VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/vk_swiftshader_icd.json:/usr/share/vulkan/icd.d/lvp_icd.x86_64.json:/usr/share/vulkan/icd.d/lvp_icd.json
ENV VK_DRIVER_FILES=/usr/share/vulkan/icd.d/vk_swiftshader_icd.json:/usr/share/vulkan/icd.d/lvp_icd.x86_64.json:/usr/share/vulkan/icd.d/lvp_icd.json
ENV XDG_RUNTIME_DIR=/tmp/runtime-root
ENV GALLIUM_DRIVER=llvmpipe
ENV MESA_GL_VERSION_OVERRIDE=4.5
ENV MESA_LOADER_DRIVER_OVERRIDE=lvp
RUN mkdir -p /tmp/runtime-root && chmod 1777 /tmp/runtime-root
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
COPY apps/backend/src/projects/vulkan_spoof.c ./apps/backend/src/projects/vulkan_spoof.c
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc-dev && \
    gcc -shared -fPIC -O2 /app/apps/backend/src/projects/vulkan_spoof.c -o /usr/lib/libvulkan_spoof.so -ldl && \
    rm -rf /var/lib/apt/lists/*
RUN npx prisma generate --schema=./apps/backend/prisma/schema.prisma
RUN chown -R node:node /app /opt/streampixel/storage
USER node
EXPOSE 5000
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./apps/backend/prisma/schema.prisma && node apps/backend/dist/main"]
