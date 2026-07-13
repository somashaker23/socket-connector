"""Provider store — manages multiple LiveKit configurations in a JSON file."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from pydantic import BaseModel

_STORE_PATH = Path("data/providers.json")
_lock = Lock()


class Provider(BaseModel):
    id: str
    display_name: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    created_at: str


class ProviderCreate(BaseModel):
    display_name: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str


class ProviderUpdate(BaseModel):
    display_name: str | None = None
    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None


def _read_all() -> list[dict[str, Any]]:
    if not _STORE_PATH.exists():
        return []
    return json.loads(_STORE_PATH.read_text())


def _write_all(providers: list[dict[str, Any]]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STORE_PATH.write_text(json.dumps(providers, indent=2))


def list_providers() -> list[Provider]:
    with _lock:
        return [Provider(**p) for p in _read_all()]


def get_provider(provider_id: str) -> Provider | None:
    with _lock:
        for p in _read_all():
            if p["id"] == provider_id:
                return Provider(**p)
    return None


def create_provider(data: ProviderCreate) -> Provider:
    provider = Provider(
        id=str(uuid.uuid4()),
        display_name=data.display_name,
        livekit_url=data.livekit_url,
        livekit_api_key=data.livekit_api_key,
        livekit_api_secret=data.livekit_api_secret,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    with _lock:
        providers = _read_all()
        providers.append(provider.model_dump())
        _write_all(providers)
    return provider


def update_provider(provider_id: str, data: ProviderUpdate) -> Provider | None:
    with _lock:
        providers = _read_all()
        for i, p in enumerate(providers):
            if p["id"] == provider_id:
                updates = data.model_dump(exclude_none=True)
                providers[i] = {**p, **updates}
                _write_all(providers)
                return Provider(**providers[i])
    return None


def delete_provider(provider_id: str) -> bool:
    with _lock:
        providers = _read_all()
        filtered = [p for p in providers if p["id"] != provider_id]
        if len(filtered) == len(providers):
            return False
        _write_all(filtered)
        return True