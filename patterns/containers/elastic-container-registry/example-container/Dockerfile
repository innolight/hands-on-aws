FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server.ts ./
RUN npx tsc

FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]

# Default target — plain HTTP server, used by ECS / App Runner patterns (tag: latest)
FROM base AS server

# Lambda target — adds Lambda Web Adapter extension (tag: lambda)
# See more https://github.com/awslabs/aws-lambda-web-adapter
FROM base AS lambda
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0-rc1 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=3000
ENV AWS_LWA_READINESS_CHECK_PATH=/health
