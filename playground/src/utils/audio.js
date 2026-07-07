import { encodeFloat32ToUlaw, decodeUlawToFloat32 } from "./ulaw";

const TARGET_SAMPLE_RATE = 8000;
const CHUNK_DURATION_MS = 20;
const CHUNK_SIZE = (TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000; // 160 samples

// Downsample from source rate to 8kHz
function downsample(buffer, fromRate, toRate) {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, buffer.length - 1);
    const frac = srcIndex - low;
    result[i] = buffer[low] * (1 - frac) + buffer[high] * frac;
  }
  return result;
}

export class MicCapture {
  constructor(onChunk) {
    this.onChunk = onChunk; // (base64Payload, rawFloat32) => void
    this.stream = null;
    this.audioCtx = null;
    this.processor = null;
    this.muted = false;
    this.residual = new Float32Array(0);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    // Analyser sits between source and processor so it sees live mic data
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    // ScriptProcessorNode for broad compatibility (AudioWorklet is better but needs separate file)
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => this._process(e);
    source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  _process(e) {
    if (this.muted) return;
    const input = e.inputBuffer.getChannelData(0);
    const downsampled = downsample(input, this.audioCtx.sampleRate, TARGET_SAMPLE_RATE);

    // Concatenate with leftover from previous call
    const combined = new Float32Array(this.residual.length + downsampled.length);
    combined.set(this.residual);
    combined.set(downsampled, this.residual.length);

    let offset = 0;
    while (offset + CHUNK_SIZE <= combined.length) {
      const chunk = combined.slice(offset, offset + CHUNK_SIZE);
      const ulaw = encodeFloat32ToUlaw(chunk);
      const base64 = btoa(String.fromCharCode(...ulaw));
      this.onChunk(base64, chunk);
      offset += CHUNK_SIZE;
    }
    this.residual = combined.slice(offset);
  }

  setMuted(muted) {
    this.muted = muted;
  }

  stop() {
    this.processor?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    this.processor = null;
    this.analyser = null;
    this.stream = null;
    this.audioCtx = null;
    this.residual = new Float32Array(0);
  }
}

export class AudioPlayer {
  constructor() {
    this.audioCtx = null;
    this.queue = [];
    this.playing = false;
    this.nextTime = 0;
    this.onLevel = null; // (level: number) => void
    this.analyser = null;
    this.analyserData = null;
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
  }

  enqueue(base64Payload) {
    this._ensureCtx();
    const binary = atob(base64Payload);
    const ulaw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) ulaw[i] = binary.charCodeAt(i);
    const float32 = decodeUlawToFloat32(ulaw);

    // Check if audio has actual content (not silence)
    let maxVal = 0;
    for (let i = 0; i < float32.length; i++) {
      const abs = Math.abs(float32[i]);
      if (abs > maxVal) maxVal = abs;
    }

    if (!this._logged) {
      console.log("[AudioPlayer] state:", this.audioCtx.state, "sampleRate:", this.audioCtx.sampleRate,
        "payloadLen:", binary.length, "peak:", maxVal.toFixed(4));
      this._logged = true;
    }

    const buffer = this.audioCtx.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);

    const now = this.audioCtx.currentTime;
    const startTime = Math.max(now, this.nextTime);
    source.start(startTime);
    this.nextTime = startTime + buffer.duration;
  }

  getAnalyserData() {
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this.analyserData);
    return this.analyserData;
  }

  clear() {
    this.nextTime = 0;
  }

  stop() {
    this.audioCtx?.close();
    this.audioCtx = null;
    this.analyser = null;
    this.nextTime = 0;
  }
}
