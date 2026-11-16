FROM oven/bun:1.1.38
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --network-concurrency 1
COPY . .
RUN bun run build
EXPOSE 3000
CMD ["bun", "run", "start:bun"]
