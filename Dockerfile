# Multi-stage build for AgentLang CLI
FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Production image, copy all the files and run the app
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 agentlang

# Copy the built application
COPY --from=builder --chown=agentlang:nodejs /app/out ./out
COPY --from=builder --chown=agentlang:nodejs /app/bin ./bin
COPY --from=deps --chown=agentlang:nodejs /app/node_modules ./node_modules
COPY --chown=agentlang:nodejs package.json ./

# Set the binary as executable
RUN chmod +x ./bin/cli.js

USER agentlang

# Set the default command
ENTRYPOINT ["node", "./bin/cli.js"]
CMD ["--help"] 