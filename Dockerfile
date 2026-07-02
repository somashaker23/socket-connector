FROM node:22-slim AS playground
WORKDIR /build
COPY playground/package.json playground/package-lock.json ./
RUN npm ci
COPY playground/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY app/ app/
COPY main.py .
COPY --from=playground /build/dist playground/dist

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]