import asyncio
import logging
import secrets
import time

import aiohttp
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .connector import create_connector_session
from . import metrics

logger = logging.getLogger(__name__)

router = APIRouter()

# Store connect URLs server-side so LiveKit URLs are never exposed.
# TTL-based cleanup: entries expire after 30s if unused.
_pending_sessions: dict[str, tuple[str, float]] = {}
_SESSION_TTL = 30.0  # seconds


def _cleanup_expired():
    now = time.monotonic()
    expired = [k for k, (_, ts) in _pending_sessions.items() if now - ts > _SESSION_TTL]
    for k in expired:
        del _pending_sessions[k]


@router.api_route("/smartflo/connect", methods=["GET", "POST"])
async def smartflo_connect(request: Request) -> JSONResponse:
    """SmartFlo calls this to get a connect_url for a call."""
    if request.method == "POST":
        body = await request.json()
    else:
        body = dict(request.query_params)

    call_id = body.get("callId", "")
    from_number = body.get("fromNumber", "")
    to_number = body.get("toNumber", "")
    direction = body.get("direction", "inbound")
    agent_name = body.get("agentName", "")

    if not call_id:
        return JSONResponse({"success": False, "error": "callId is required"}, status_code=400)

    t0 = time.monotonic()
    try:
        connect_url = await create_connector_session(
            call_sid=call_id,
            from_number=from_number,
            to_number=to_number,
            direction=direction,
            agent_name=agent_name or None,
        )
    except Exception as exc:
        metrics.connector_requests_total.labels(direction=direction, status="error").inc()
        logger.error("Failed to create connector session", extra={"call_id": call_id, "error": str(exc)})
        return JSONResponse({"success": False, "error": str(exc)}, status_code=500)

    metrics.connector_latency_seconds.observe(time.monotonic() - t0)
    metrics.connector_requests_total.labels(direction=direction, status="success").inc()

    # Store connect URL server-side, return opaque session token
    _cleanup_expired()
    session_id = secrets.token_urlsafe(16)
    _pending_sessions[session_id] = (connect_url, time.monotonic())

    logger.info("Connector session created", extra={"call_id": call_id, "session_id": session_id})

    host = request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    scheme = "wss" if proto == "https" else "ws"
    wss_url = f"{scheme}://{host}/ws/stream/{session_id}"

    return JSONResponse({"success": True, "wss_url": wss_url})


@router.websocket("/ws/stream/{session_id}")
async def ws_stream(websocket: WebSocket, session_id: str):
    """Proxy WebSocket — looks up stored connect URL by session ID."""
    entry = _pending_sessions.pop(session_id, None)
    if not entry:
        await websocket.close(code=4004, reason="Invalid or expired session")
        return
    target_url, created_at = entry
    if time.monotonic() - created_at > _SESSION_TTL:
        await websocket.close(code=4004, reason="Invalid or expired session")
        return
    await websocket.accept()

    async with aiohttp.ClientSession() as session:
        try:
            async with session.ws_connect(target_url) as lk_ws:
                logger.info("WS proxy connected", extra={"target": target_url[:80]})

                async def browser_to_livekit():
                    try:
                        while True:
                            data = await websocket.receive_text()
                            await lk_ws.send_str(data)
                    except WebSocketDisconnect:
                        pass

                async def livekit_to_browser():
                    try:
                        async for msg in lk_ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await websocket.send_text(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY:
                                await websocket.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                    except WebSocketDisconnect:
                        pass

                tasks = [
                    asyncio.create_task(browser_to_livekit()),
                    asyncio.create_task(livekit_to_browser()),
                ]
                _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
        except Exception as exc:
            logger.error("WS proxy error", extra={"error": str(exc)})
        finally:
            try:
                await websocket.close()
            except Exception:
                pass


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
