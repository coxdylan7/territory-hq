FROM node:22-alpine

WORKDIR /app

COPY api/package*.json api/
COPY web/package*.json web/

RUN npm --prefix api install --no-audit --no-fund && \
    npm --prefix web install --no-audit --no-fund

COPY . .

RUN npm --prefix web run build && rm -rf web/node_modules

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

CMD ["node", "api/src/server.js"]