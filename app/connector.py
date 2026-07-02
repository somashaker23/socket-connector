import logging

from livekit.api import LiveKitAPI, RoomAgentDispatch
from livekit.protocol.connector_twilio import ConnectTwilioCallRequest

from .config import get_settings

logger = logging.getLogger(__name__)


async def create_connector_session(
    call_sid: str,
    from_number: str,
    to_number: str,
    direction: str,
) -> str:
    """Call ConnectTwilioCall API and return the connect_url."""
    settings = get_settings()

    api = LiveKitAPI(
        url=settings.LIVEKIT_URL,
        api_key=settings.LIVEKIT_API_KEY,
        api_secret=settings.LIVEKIT_API_SECRET,
    )

    room_name = f"smartflo-{call_sid}"
    if direction == "outbound":
        call_direction = ConnectTwilioCallRequest.TWILIO_CALL_DIRECTION_OUTBOUND
    else:
        call_direction = ConnectTwilioCallRequest.TWILIO_CALL_DIRECTION_INBOUND

    request = ConnectTwilioCallRequest(
        room_name=room_name,
        participant_identity=from_number,
        participant_name=to_number,
        twilio_call_direction=call_direction,
    )

    if settings.LIVEKIT_AGENT_NAME:
        request.agents.append(
            RoomAgentDispatch(agent_name=settings.LIVEKIT_AGENT_NAME)
        )

    try:
        response = await api.connector.connect_twilio_call(request)
        logger.info(
            "Connector session created",
            extra={
                "call_sid": call_sid,
                "room_name": room_name,
                "participant_identity": from_number,
            },
        )
        return response.connect_url
    finally:
        await api.aclose()
