// Twilio Media Streams protocol message builders

let sequenceNumber = 0;

export function resetSequence() {
  sequenceNumber = 0;
}

export function buildConnected() {
  return JSON.stringify({
    event: "connected",
    protocol: "Call",
    version: "1.0.0",
  });
}

export function buildStart(callSid, streamSid, fromNumber, toNumber) {
  sequenceNumber++;
  return JSON.stringify({
    event: "start",
    sequenceNumber: String(sequenceNumber),
    start: {
      streamSid,
      accountSid: "playground",
      callSid,
      tracks: ["inbound"],
      from: fromNumber,
      to: toNumber,
      fromNumber,
      toNumber,
      direction: "inbound",
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1,
      },
      customParameters: {},
    },
    streamSid,
  });
}

export function buildMedia(streamSid, payload, timestamp) {
  sequenceNumber++;
  return JSON.stringify({
    event: "media",
    sequenceNumber: String(sequenceNumber),
    media: {
      track: "inbound",
      chunk: String(sequenceNumber),
      timestamp: String(timestamp),
      payload,
    },
    streamSid,
  });
}

export function buildDtmf(streamSid, digit) {
  sequenceNumber++;
  return JSON.stringify({
    event: "dtmf",
    sequenceNumber: String(sequenceNumber),
    dtmf: {
      track: "inbound_track",
      digit,
    },
    streamSid,
  });
}

export function buildMark(streamSid, name) {
  sequenceNumber++;
  return JSON.stringify({
    event: "mark",
    sequenceNumber: String(sequenceNumber),
    mark: { name },
    streamSid,
  });
}

export function buildClear(streamSid) {
  sequenceNumber++;
  return JSON.stringify({
    event: "clear",
    sequenceNumber: String(sequenceNumber),
    streamSid,
  });
}

export function buildStop(callSid, streamSid) {
  sequenceNumber++;
  return JSON.stringify({
    event: "stop",
    sequenceNumber: String(sequenceNumber),
    stop: {
      accountSid: "playground",
      callSid,
    },
    streamSid,
  });
}
