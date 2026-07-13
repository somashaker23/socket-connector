"""Admin routes — provider CRUD + authentication."""

import logging
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .config import get_settings
from .providers import (
    ProviderCreate,
    ProviderUpdate,
    create_provider,
    delete_provider,
    get_provider,
    list_providers,
    update_provider,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin")

# In-memory admin sessions: token -> expiry timestamp
_admin_sessions: dict[str, float] = {}
_SESSION_TTL = 86400.0  # 24 hours


class LoginRequest(BaseModel):
    password: str


def _cleanup_sessions():
    now = time.monotonic()
    expired = [k for k, v in _admin_sessions.items() if now > v]
    for k in expired:
        del _admin_sessions[k]


def _verify_admin(request: Request) -> None:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    token = auth[7:]
    _cleanup_sessions()
    if token not in _admin_sessions:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


@router.post("/login")
async def admin_login(body: LoginRequest) -> JSONResponse:
    settings = get_settings()
    if not settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Admin login not configured")
    if not secrets.compare_digest(body.password, settings.ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid password")

    token = secrets.token_urlsafe(32)
    _admin_sessions[token] = time.monotonic() + _SESSION_TTL
    _cleanup_sessions()
    return JSONResponse({"token": token})


@router.get("/providers")
async def admin_list_providers(_=Depends(_verify_admin)):
    providers = list_providers()
    return [
        {
            "id": p.id,
            "display_name": p.display_name,
            "livekit_url": p.livekit_url,
            "livekit_api_key": p.livekit_api_key,
            "livekit_api_secret": "***",
            "created_at": p.created_at,
        }
        for p in providers
    ]


@router.post("/providers")
async def admin_create_provider(body: ProviderCreate, _=Depends(_verify_admin)):
    provider = create_provider(body)
    logger.info("Provider created", extra={"id": provider.id, "name": provider.display_name})
    return {"id": provider.id, "display_name": provider.display_name}


@router.put("/providers/{provider_id}")
async def admin_update_provider(provider_id: str, body: ProviderUpdate, _=Depends(_verify_admin)):
    # Treat empty strings as "don't update" (e.g. blank secret = keep existing)
    if body.livekit_api_secret == "":
        body.livekit_api_secret = None
    if body.livekit_url == "":
        body.livekit_url = None
    if body.livekit_api_key == "":
        body.livekit_api_key = None
    if body.display_name == "":
        body.display_name = None
    provider = update_provider(provider_id, body)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    logger.info("Provider updated", extra={"id": provider_id})
    return {"id": provider.id, "display_name": provider.display_name}


@router.delete("/providers/{provider_id}")
async def admin_delete_provider(provider_id: str, _=Depends(_verify_admin)):
    if not delete_provider(provider_id):
        raise HTTPException(status_code=404, detail="Provider not found")
    logger.info("Provider deleted", extra={"id": provider_id})
    return {"ok": True}