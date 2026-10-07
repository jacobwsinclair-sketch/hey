FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# The SQLite database lives on a mounted volume so it survives redeploys.
ENV DATABASE_FILE=/data/registrations.db \
    PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "src/server.js"]
