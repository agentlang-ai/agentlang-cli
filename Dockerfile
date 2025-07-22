FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm

ENV PNPM_HOME=/usr/local/bin

RUN pnpm install -g agentlangcli

COPY run.sh .

CMD ["/app/run.sh"]