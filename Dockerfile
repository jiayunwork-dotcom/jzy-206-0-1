FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npx tsc --project tsconfig.json && npm prune --omit=dev

EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
