# ==========================================
# Etapa 1: Build
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

# ==========================================
# Etapa 2: Producción
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005
ENV SESSIONS_DIR=/app/sessions_data

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Crear directorio de persistencia para sesiones de WhatsApp
RUN mkdir -p /app/sessions_data && chown -R node:node /app

USER node

EXPOSE 3005

VOLUME ["/app/sessions_data"]

CMD ["node", "dist/index.js"]
