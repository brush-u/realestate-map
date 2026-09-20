# 내 집 한방 뽑기 - Cloud Run 배포용 Dockerfile
FROM node:20-slim

WORKDIR /app

# 의존성만 먼저 복사해서 캐시 활용 (package.json이 안 바뀌면 npm install 스킵됨)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 나머지 소스 복사
COPY . .

# Cloud Run은 컨테이너에 PORT 환경변수를 주입한다 (보통 8080). server.js가
# process.env.PORT를 그대로 쓰므로 여기서 고정값을 넣지 않아도 된다.
ENV NODE_ENV=production

CMD ["node", "server.js"]
