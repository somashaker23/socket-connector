from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    LIVEKIT_URL: str
    LIVEKIT_API_KEY: str
    LIVEKIT_API_SECRET: str
    LIVEKIT_AGENT_NAME: str | None = None
    ADMIN_PASSWORD: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
