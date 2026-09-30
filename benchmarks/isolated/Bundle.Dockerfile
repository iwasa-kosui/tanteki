FROM node:24-bookworm-slim
COPY skill/ /opt/skill/
WORKDIR /opt/skill
RUN npm ci --ignore-scripts --omit=dev --cache /opt/skill/.npm-cache \
    && chmod -R a+rX /opt/skill && mkdir -p /workspace
COPY package.json package-lock.json /opt/runner/
RUN npm ci --prefix /opt/runner --ignore-scripts --omit=dev && npm cache clean --force
COPY *.ts /opt/runner/
ENTRYPOINT ["node", "/opt/runner/lint-worker.ts"]
