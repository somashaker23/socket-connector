import asyncio
import json
import logging
import secrets
import time

import aiohttp
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .connector import create_connector_session
from .providers import list_providers
from . import metrics

logger = logging.getLogger(__name__)

router = APIRouter()

# Test-only static endpoint for verifying SmartFlo's WS handshake and event
# stream in isolation, without touching LiveKit. Not part of the call flow.
SMARTFLO_TEST_TOKEN = "820abcqwerty"

# Tracks connections to /ws/smartflo-test so scripts/pickup_test.py can poll
# /ws/smartflo-test/status and detect a new connection without parsing logs.
_test_ws_connect_count = 0
_test_ws_last_connected_at: float | None = None

# Browser clients connected to /ws/smartflo-test/logs, watching events live.
_log_viewers: set[WebSocket] = set()


async def _broadcast_log(entry: dict) -> None:
    entry = {"timestamp": time.time(), **entry}
    dead = []
    for viewer in _log_viewers:
        try:
            await viewer.send_json(entry)
        except Exception:
            dead.append(viewer)
    for viewer in dead:
        _log_viewers.discard(viewer)

# Store connect URLs server-side so LiveKit URLs are never exposed.
# TTL-based cleanup: entries expire after 30s if unused.
_pending_sessions: dict[str, tuple[str, float]] = {}
_SESSION_TTL = 120.0  # seconds


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
    provider_id = body.get("providerId", "")

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
            provider_id=provider_id or None,
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


@router.websocket("/ws/smartflo-test")
async def smartflo_test_stream(websocket: WebSocket):
    """Static test endpoint: authenticates via X-Auth-Token and logs every
    SmartFlo event verbatim. Bypasses LiveKit entirely — for verifying
    SmartFlo's handshake and event stream in isolation. Not part of the call flow."""
    client = websocket.client
    # token = websocket.headers.get("x-auth-token")
    # if token != SMARTFLO_TEST_TOKEN:
    #     logger.warning("SmartFlo test WS rejected: bad token", extra={"client": str(client)})
    #     await websocket.close(code=4001, reason="Invalid or missing X-Auth-Token")
    #     return

    await websocket.accept()
    logger.info("SmartFlo test WS connected", extra={"client": str(client)})

    global _test_ws_connect_count, _test_ws_last_connected_at
    _test_ws_connect_count += 1
    _test_ws_last_connected_at = time.time()
    await _broadcast_log({"type": "connect", "client": str(client)})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                logger.warning("SmartFlo test WS non-JSON frame", extra={"raw": raw[:200]})
                await _broadcast_log({"type": "warning", "client": str(client), "raw": raw[:200]})
                continue

            event = data.get("event", "unknown")
            if event == "media":
                # Media frames arrive every ~20ms with a large base64 payload —
                # log a summary instead of flooding the log with audio bytes.
                media = data.get("media", {})
                summary = {
                    "chunk": media.get("chunk"),
                    "media_timestamp": media.get("timestamp"),
                    "payload_bytes": len(media.get("payload", "")),
                }
                logger.info("SmartFlo event: media", extra={"event": event, **summary})
                await _broadcast_log({"type": "event", "client": str(client), "event": event, "detail": summary})
            else:
                logger.info(f"SmartFlo event: {event}", extra={"event": event, "payload": data})
                await _broadcast_log({"type": "event", "client": str(client), "event": event, "detail": data})
    except WebSocketDisconnect as exc:
        logger.info("SmartFlo test WS disconnected", extra={"client": str(client), "code": exc.code})
        await _broadcast_log({"type": "disconnect", "client": str(client), "code": exc.code})


@router.websocket("/ws/smartflo-test/logs")
async def smartflo_test_logs(websocket: WebSocket):
    """Browser clients (playground live-logs page) connect here to watch
    /ws/smartflo-test activity in real time. Read-only broadcast channel —
    viewers never send anything meaningful, just held open until they close."""
    await websocket.accept()
    _log_viewers.add(websocket)
    logger.info("Log viewer connected", extra={"client": str(websocket.client), "viewers": len(_log_viewers)})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _log_viewers.discard(websocket)
        logger.info("Log viewer disconnected", extra={"viewers": len(_log_viewers)})


@router.get("/ws/smartflo-test/status")
async def smartflo_test_status() -> dict:
    """Polled by scripts/pickup_test.py to detect a new /ws/smartflo-test
    connection without parsing logs."""
    return {
        "connect_count": _test_ws_connect_count,
        "last_connected_at": _test_ws_last_connected_at,
    }


@router.get("/api/providers")
async def public_providers():
    """Return only display names and IDs — no credentials."""
    return [{"id": p.id, "display_name": p.display_name} for p in list_providers()]


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
