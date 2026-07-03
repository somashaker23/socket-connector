import { decodeUlawToFloat32 } from "./ulaw";

const SAMPLE_RATE = 8000;

export class CallRecorder {
  constructor() {
    this.txChunks = [];
    this.rxChunks = [];
    this.recording = false;
  }

  start() {
    this.txChunks = [];
    this.rxChunks = [];
    this.recording = true;
  }

  stop() {
    this.recording = false;
  }

  addTx(base64Payload) {
    if (!this.recording) return;
    this.txChunks.push(base64Payload);
  }

  addRx(base64Payload) {
    if (!this.recording) return;
    this.rxChunks.push(base64Payload);
  }

  /** Decode base64 u-law chunks to a single Float32Array */
  _decode(chunks) {
    const arrays = chunks.map((b64) => {
      const bin = atob(b64);
      const ulaw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) ulaw[i] = bin.charCodeAt(i);
      return decodeUlawToFloat32(ulaw);
    });
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Float32Array(total);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }

  /** Create a WAV blob — stereo (TX=left, RX=right) */
  toWav() {
    const tx = this._decode(this.txChunks);
    const rx = this._decode(this.rxChunks);
    const length = Math.max(tx.length, rx.length);
    if (length === 0) return null;

    const numChannels = 2;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = length * numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // WAV header
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    // Interleave TX (left) and RX (right)
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const txSample = i < tx.length ? Math.max(-1, Math.min(1, tx[i])) : 0;
      const rxSample = i < rx.length ? Math.max(-1, Math.min(1, rx[i])) : 0;
      view.setInt16(offset, txSample < 0 ? txSample * 0x8000 : txSample * 0x7fff, true);
      offset += 2;
      view.setInt16(offset, rxSample < 0 ? rxSample * 0x8000 : rxSample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([buffer], { type: "audio/wav" });
  }

  download(filename = "call-recording.wav") {
    const blob = this.toWav();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  get hasData() {
    return this.txChunks.length > 0 || this.rxChunks.length > 0;
  }
}
