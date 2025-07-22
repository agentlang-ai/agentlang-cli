FROM node:22-alpine

WORKDIR /

RUN npm install -g pnpm

ENV PNPM_HOME=/usr/local/bin

RUN pnpm install -g agentlangcli

COPY run.sh .

RUN apk add --no-cache git

CMD ["sh", "run.sh"]