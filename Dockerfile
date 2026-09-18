FROM node:22-alpine

WORKDIR /app

COPY api/package*.json api/
COPY web/package*.json web/

RUN npm --prefix api install --no-audit --no-fund && \
    npm --prefix web install --no-audit --no-fund

COPY . .

RUN npm --prefix web run build && rm -rf web/node_modules

ENV NODE_ENV=production
ENV SERVE_WEB=true
ENV PORT=8080

EXPOSE 8080

CMD ["node", "api/src/server.js"]