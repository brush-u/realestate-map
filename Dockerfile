# Cloud Run 배포용 Dockerfile
FROM node:20-slim

WORKDIR /app

# package.json/package-lock.json만 먼저 복사해서 의존성 설치 레이어를 캐싱 (재빌드 속도 향상)
COPY package*.json ./
RUN npm ci --omit=dev

# 나머지 소스 복사 (.dockerignore로 node_modules, .env, .git 등은 제외됨)
COPY . .

ENV NODE_ENV=production
# Cloud Run은 PORT 환경변수를 주입하며, server.js가 이미 process.env.PORT를 사용합니다.
EXPOSE 8080

CMD ["node", "server.js"]
