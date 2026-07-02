import logging
import time

from fastapi import APIRouter, Request
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
    return JSONResponse({"success": True, "connect_url": connect_url})


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
