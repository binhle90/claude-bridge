FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache curl && npm install --omit=dev
COPY server/ ./server/
RUN mkdir -p /app/data
ENV NODE_ENV=production
ENV PORT=3010
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:3010/api/health || exit 1
CMD ["node", "server/index.js"]
