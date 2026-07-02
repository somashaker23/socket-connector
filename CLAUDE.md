# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SmartFlo-to-LiveKit Connector — a thin HTTP service that bridges SmartFlo calls into LiveKit rooms using LiveKit's built-in Twilio Connector. SmartFlo's WebSocket protocol is compatible with Twilio Media Streams, so SmartFlo connects **directly** to LiveKit's Twilio Connector WebSocket (no proxy needed). Our server only handles the `ConnectTwilioCall` API call and returns the `connect_url`.

Python 3.12+, managed with `uv`.

## Commands

- **Install dependencies:** `uv sync`
- **Run dev server:** `uv run uvicorn app:app --reload`
- **Run server (production):** `uv run uvicorn app:app --host 0.0.0.0 --port 8000`

## Architecture

```
SmartFlo HTTP --> [POST /smartflo/connect] --> ConnectTwilioCall API --> connect_url
SmartFlo WS  ----------------------------------------directly----------> LiveKit Twilio Connector WS
```

`app/` package structure with FastAPI:

- `app/__init__.py` — FastAPI app instance, lifespan (startup/shutdown), Prometheus instrumentator
- `app/config.py` — Pydantic `BaseSettings` loading from `.env` (LIVEKIT_URL, API keys, etc.)
- `app/connector.py` — LiveKit `ConnectTwilioCall` API wrapper, creates rooms per call
- `app/routes.py` — Endpoints: `GET|POST /smartflo/connect`, `GET /health`
- `app/logging.py` — JSON structured logging via python-json-logger
- `app/metrics.py` — Prometheus metrics (connector request count, latency)
- `main.py` — Uvicorn entrypoint

## Key Dependencies

- `livekit-api` — LiveKit server API client (ConnectTwilioCall)
- `pydantic-settings` — Typed env var configuration
- `prometheus-fastapi-instrumentator` + `prometheus-client` — Metrics on `/metrics`
- `python-json-logger` — Structured JSON logs

## Environment

Requires a `.env` file (see `.env.example`):
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- Optional: `LIVEKIT_AGENT_NAME` for auto agent dispatch

## Call Flow

### Inbound Call (Caller → SmartFlo → LiveKit)

An external caller dials in. SmartFlo receives the call and needs a LiveKit room to connect to.

```
Caller → SmartFlo PBX → [POST /smartflo/connect] → LiveKit Room ← AI Agent
                 |                                        ↑
                 +-----(WS directly to connect_url)-------+
```

**Step-by-step:**

1. **SmartFlo requests a session** — POSTs to `/smartflo/connect` with `callId`, `fromNumber`, `toNumber`, `direction=inbound`.

2. **Our server calls `ConnectTwilioCall`** — This LiveKit API creates a room named `smartflo-{callId}`, registers a participant (identity = `fromNumber`, name = `toNumber`), and returns a `connect_url` (a LiveKit-hosted WebSocket URL). If `LIVEKIT_AGENT_NAME` is configured, a `RoomAgentDispatch` is attached so LiveKit auto-dispatches the agent into the room.

3. **We return the `connect_url`** — Response: `{"success": true, "connect_url": "wss://..."}`.

4. **SmartFlo connects directly to LiveKit** — SmartFlo opens a WebSocket to the `connect_url` using the Twilio Media Streams protocol. LiveKit's Twilio Connector handles all audio transcoding (G.711 u-law ↔ Opus), track publishing, and room management. No proxy needed.

5. **Audio flows bidirectionally** — SmartFlo sends `media` events (G.711 u-law, base64) directly to LiveKit's connector, which decodes and publishes the audio as a track. Agent audio flows back as `media` events to SmartFlo.

6. **Call ends** — SmartFlo sends `stop` and closes the WebSocket. LiveKit detects the disconnect, removes the participant, and auto-deletes the empty room.

### Outbound Call (Agent → SmartFlo → External Number)

An AI agent or application initiates a call through SmartFlo to an external number.

```
AI Agent → LiveKit Room → (WS connect_url) → SmartFlo PBX → External Number
```

**Step-by-step:**

1. **Application requests a session** — POSTs to `/smartflo/connect` with `callId`, `fromNumber`, `toNumber`, `direction=outbound`.

2. **Our server calls `ConnectTwilioCall`** — Same as inbound, but with `TWILIO_CALL_DIRECTION_OUTBOUND`. LiveKit creates room `smartflo-{callId}` and returns a `connect_url`.

3. **SmartFlo connects directly** — SmartFlo opens a WebSocket to `connect_url`. The agent speaks first — its audio is transcoded by LiveKit's connector and sent as `media` events to SmartFlo, which plays them to the called party. The called party's audio flows back through the same path.

4. **Call ends** — Same teardown as inbound. WebSocket closes, room auto-deletes.

### LiveKit Room & Session Lifecycle

| Phase | What happens |
|-------|-------------|
| **Room creation** | `ConnectTwilioCall` API creates room `smartflo-{callSid}`. One room per call, never shared. |
| **Participant join** | The caller joins as a participant with `identity=fromNumber`, `name=toNumber`. LiveKit's Twilio Connector manages the participant. |
| **Agent dispatch** | If `LIVEKIT_AGENT_NAME` is configured, LiveKit dispatches the named agent into the room automatically on creation. |
| **Audio transcoding** | Handled entirely by LiveKit's Twilio Connector: G.711 u-law (8kHz, mono) ↔ Opus. Zero audio processing on our side. |
| **Teardown** | When SmartFlo closes the WebSocket (sends `stop`), the connector participant leaves. LiveKit auto-deletes empty rooms. |

## SmartFlo/Twilio Media Stream Events

SmartFlo uses the same WebSocket protocol as [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages). All messages are JSON with an `event` field. These flow directly between SmartFlo and LiveKit's Twilio Connector — our server is not in this path.

### Events from SmartFlo → LiveKit Connector

| Event | Purpose | Key Fields |
|-------|---------|------------|
| `connected` | Initial handshake, confirms protocol version | `protocol`, `version` |
| `start` | Stream metadata: call SID, tracks, media format (u-law/8000/mono) | `start.callSid`, `start.streamSid`, `start.mediaFormat`, `start.customParameters` |
| `media` | Raw audio chunk, base64-encoded G.711 u-law | `media.payload`, `media.chunk`, `media.timestamp` |
| `dtmf` | Caller pressed a key (0-9, *, #) | `dtmf.digit`, `dtmf.track` |
| `stop` | Call/stream ended | `stop.callSid`, `stop.accountSid` |

### Events from LiveKit Connector → SmartFlo

| Event | Purpose | Key Fields |
|-------|---------|------------|
| `media` | Audio from agent/room back to caller, base64 u-law | `streamSid`, `media.payload` |
| `mark` | Signals a named point in the audio playback queue. SmartFlo sends back a `mark` event when playback reaches that point. | `streamSid`, `mark.name` |
| `clear` | Flush all queued audio (e.g. agent was interrupted) | `streamSid` |

### Event Flow Diagram

```
SmartFlo                                         LiveKit Twilio Connector
   |                                                     |
   |---connected------(direct WebSocket)---------------->|
   |---start (callSid)---------------------------------->|  Room + participant ready
   |                                                     |
   |---media (audio chunk)------------------------------>|  u-law → Opus → room track
   |---media-------------------------------------------->|
   |                                                     |
   |<--media---------------------------------------------|  Agent audio → Opus → u-law
   |<--media---------------------------------------------|
   |<--mark----------------------------------------------|  Playback marker
   |---mark (ack)--------------------------------------->|  Playback reached mark
   |                                                     |
   |<--clear---------------------------------------------|  Agent interrupted
   |---dtmf--------------------------------------------->|  Key press
   |---stop--------------------------------------------->|  Call ends, room cleaned up
```

## No test framework configured yet.