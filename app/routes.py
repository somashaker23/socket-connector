import asyncio
import logging
import time
from urllib.parse import unquote

import aiohttp
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .connector import create_connector_session
from . import metrics

logger = logging.getLogger(__name__)

router = APIRouter()


@router.api_route("/smartflo/connect", methods=["GET", "POST"])
async def smartflo_connect(request: Request) -> JSONResponse:
    """SmartFlo calls this to get a LiveKit connect_url for a call."""
    if request.method == "POST":
        body = await request.json()
    else:
        body = dict(request.query_params)

    call_id = body.get("callId", "")
    from_number = body.get("fromNumber", "")
    to_number = body.get("toNumber", "")
    direction = body.get("direction", "inbound")

    if not call_id:
        return JSONResponse({"success": False, "error": "callId is required"}, status_code=400)

    t0 = time.monotonic()
    try:
        connect_url = await create_connector_session(
            call_sid=call_id,
            from_number=from_number,
            to_number=to_number,
            direction=direction,
        )
    except Exception as exc:
        metrics.connector_requests_total.labels(direction=direction, status="error").inc()
        logger.error("Failed to create connector session", extra={"call_id": call_id, "error": str(exc)})
        return JSONResponse({"success": False, "error": str(exc)}, status_code=500)

    metrics.connector_latency_seconds.observe(time.monotonic() - t0)
    metrics.connector_requests_total.labels(direction=direction, status="success").inc()

    logger.info("Connector session created", extra={"call_id": call_id, "connect_url": connect_url})
    return JSONResponse({"success": True, "wss_url": connect_url})


@router.websocket("/ws/proxy")
async def ws_proxy(websocket: WebSocket, url: str):
    """Proxy WebSocket for the playground. Strips Origin header so LiveKit accepts the connection."""
    target_url = unquote(url)
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
