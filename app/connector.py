import logging

from livekit.api import LiveKitAPI, RoomAgentDispatch
from livekit.protocol.connector_twilio import ConnectTwilioCallRequest

from .config import get_settings
from .providers import Provider, get_provider

logger = logging.getLogger(__name__)


async def create_connector_session(
    call_sid: str,
    from_number: str,
    to_number: str,
    direction: str,
    agent_name: str | None = None,
    provider_id: str | None = None,
) -> str:
    """Call ConnectTwilioCall API and return the connect_url."""
    settings = get_settings()

    # Use provider credentials if specified, else fall back to env vars
    provider: Provider | None = None
    if provider_id:
        provider = get_provider(provider_id)
        if not provider:
            raise ValueError(f"Provider '{provider_id}' not found")

    api = LiveKitAPI(
        url=provider.livekit_url if provider else settings.LIVEKIT_URL,
        api_key=provider.livekit_api_key if provider else settings.LIVEKIT_API_KEY,
        api_secret=provider.livekit_api_secret if provider else settings.LIVEKIT_API_SECRET,
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

    dispatch_name = agent_name or settings.LIVEKIT_AGENT_NAME
    if dispatch_name:
        request.agents.append(
            RoomAgentDispatch(agent_name=dispatch_name)
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
