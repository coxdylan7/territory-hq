# Build context: repository root (docker build -f portal/Dockerfile .)
FROM node:22-alpine

WORKDIR /app

COPY portal/api/package*.json portal/api/
COPY portal/web/package*.json portal/web/

RUN npm --prefix portal/api install --no-audit --no-fund && \
    npm --prefix portal/web install --no-audit --no-fund

COPY portal/api portal/api
COPY portal/web portal/web
# portal/api imports shared cookie, CSRF, session and security-header helpers.
COPY api/src api/src

RUN npm --prefix portal/web run build && rm -rf portal/web/node_modules

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

CMD ["node", "portal/api/src/server.js"]
