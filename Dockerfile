FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg font-noto-cjk fontconfig ca-certificates tini \
    && mkdir -p /app/.local/uploads /app/.local/object-cache \
    && chown -R node:node /app
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 AUTH_REQUIRED=true WORKER_EXTERNAL=true FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
USER node
EXPOSE 4317
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server/index.ts"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=4 CMD node -e "fetch('http://127.0.0.1:4317/api/health',{headers:{host:new URL(process.env.APP_PUBLIC_URL||'http://localhost:4317').host}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
