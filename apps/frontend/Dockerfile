FROM node:20-alpine AS development
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY apps/frontend/package*.json ./apps/frontend/
COPY packages/shared ./packages/shared/
RUN npm install
COPY apps/frontend ./apps/frontend/
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace=apps/frontend"]

FROM node:20-alpine AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/shared ./packages/shared/
COPY apps/frontend ./apps/frontend/
RUN npm install
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/frontend

FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
COPY apps/frontend/package*.json ./apps/frontend/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=builder /app/apps/frontend/next.config.js ./apps/frontend/next.config.js
EXPOSE 3000
ENV PORT=3000
CMD ["npm", "run", "start", "--workspace=apps/frontend"]
