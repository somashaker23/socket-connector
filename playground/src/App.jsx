import { useState, useRef, useCallback, useEffect } from "react";
import Waveform from "./components/Waveform";
import DtmfKeypad from "./components/DtmfKeypad";
import EventLog from "./components/EventLog";
import LatencyPanel from "./components/LatencyPanel";
import AdminPanel from "./components/AdminPanel";
import { MicCapture, AudioPlayer } from "./utils/audio";
import { CallRecorder } from "./utils/recorder";
import {
  resetSequence,
  buildConnected,
  buildStart,
  buildMedia,
  buildDtmf,
  buildMark,
  buildClear,
  buildStop,
} from "./utils/protocol";
import "./App.css";

const STATUS = { DISCONNECTED: 0, CONNECTING: 1, CONNECTED: 2, STREAMING: 3 };
const STATUS_LABELS = ["Disconnected", "Connecting...", "Connected", "Streaming"];
const STATUS_COLORS = ["#f87171", "#fbbf24", "#60a5fa", "#4ade80"];

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
}

export default function App() {
  // Providers
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [providersLoading, setProvidersLoading] = useState(true);

  // Admin
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [showAdmin, setShowAdmin] = useState(false);

  // Config
  const [backendUrl, setBackendUrl] = useState("");
  const [callId, setCallId] = useState(`call-${Date.now()}`);
  const [fromNumber, setFromNumber] = useState("+911234567890");
  const [toNumber, setToNumber] = useState("+910987654321");
  const [direction, setDirection] = useState("inbound");
  const [agentName, setAgentName] = useState("");

  // State
  const [status, setStatus] = useState(STATUS.DISCONNECTED);
  const [connectUrl, setConnectUrl] = useState("");
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({
    connectLatency: null,
    wsHandshake: null,
    markRtt: null,
    mediaSent: 0,
    mediaRecv: 0,
    recvInterval: null,
    duration: "0:00",
    firstMediaLatency: null,
  });
  const [markName, setMarkName] = useState("ping-1");
  const [healthStatus, setHealthStatus] = useState(null);
  const [recording, setRecording] = useState(false);
  const [autoRecord, setAutoRecord] = useState(true);

  // Refs
  const wsRef = useRef(null);
  const micRef = useRef(null);
  const playerRef = useRef(null);
  const streamSidRef = useRef(`stream-${Date.now()}`);
  const mediaTimestampRef = useRef(0);
  const statsRef = useRef({ ...stats });
  const pendingMarksRef = useRef({});
  const startTimeRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const lastMediaRecvRef = useRef(null);
  const firstMediaSentRef = useRef(null);
  const micAnalyserRef = useRef(null);
  const micAnalyserDataRef = useRef(null);
  const recorderRef = useRef(new CallRecorder());

  // Fetch providers on mount
  useEffect(() => {
    fetchProviders();
  }, []);

  const fetchProviders = async () => {
    try {
      setProvidersLoading(true);
      const res = await fetch(`${backendUrl}/api/providers`);
      const data = await res.json();
      setProviders(data);
      if (data.length > 0 && !selectedProvider) {
        setSelectedProvider(data[0].id);
      }
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  };

  const handleAdminLogin = async (password) => {
    const res = await fetch(`${backendUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Login failed");
    }
    const data = await res.json();
    setAdminToken(data.token);
    localStorage.setItem("adminToken", data.token);
    setShowAdmin(true);
  };

  const handleAdminLogout = () => {
    setAdminToken("");
    localStorage.removeItem("adminToken");
    setShowAdmin(false);
  };

  const addLog = useCallback((dir, event, detail = "") => {
    setLogs((prev) => {
      if (event === "media" && prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.event === "media" && last.dir === dir) {
          const count = (last.count || 1) + 1;
          return [...prev.slice(0, -1), { ...last, count, detail: `${count} chunks`, time: ts() }];
        }
      }
      const next = [...prev, { time: ts(), dir, event, detail, count: 1 }];
      return next.length > 500 ? next.slice(-300) : next;
    });
  }, []);

  const updateStat = useCallback((key, value) => {
    statsRef.current = { ...statsRef.current, [key]: value };
    setStats({ ...statsRef.current });
  }, []);

  // --- Session Management ---

  const handleConnect = async () => {
    if (!selectedProvider && providers.length > 0) {
      addLog("SYS", "error", "Select a provider first");
      return;
    }

    setStatus(STATUS.CONNECTING);
    setLogs([]);
    statsRef.current = { connectLatency: null, wsHandshake: null, markRtt: null, mediaSent: 0, mediaRecv: 0, recvInterval: null, duration: "0:00", firstMediaLatency: null };
    setStats({ ...statsRef.current });

    const t0 = performance.now();
    try {
      const res = await fetch(`${backendUrl}/smartflo/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callId,
          fromNumber,
          toNumber,
          direction,
          ...(agentName && { agentName }),
          ...(selectedProvider && { providerId: selectedProvider }),
        }),
      });
      const data = await res.json();
      const latency = Math.round(performance.now() - t0);
      updateStat("connectLatency", latency);

      if (!data.success) {
        addLog("SYS", "error", data.error);
        setStatus(STATUS.DISCONNECTED);
        return;
      }
      setConnectUrl(data.wss_url);
      addLog("SYS", "connected", `API ${latency}ms`);
      connectWebSocket(data.wss_url);
    } catch (err) {
      addLog("SYS", "error", err.message);
      setStatus(STATUS.DISCONNECTED);
    }
  };

  const connectWebSocket = (url) => {
    const t0 = performance.now();
    resetSequence();
    streamSidRef.current = `stream-${Date.now()}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      const handshake = Math.round(performance.now() - t0);
      updateStat("wsHandshake", handshake);
      setStatus(STATUS.CONNECTED);
      addLog("SYS", "connected", `WS handshake ${handshake}ms`);

      const connMsg = buildConnected();
      ws.send(connMsg);
      addLog("TX", "connected", "");

      const startMsg = buildStart(callId, streamSidRef.current, fromNumber, toNumber);
      ws.send(startMsg);
      addLog("TX", "start", `callSid=${callId}`);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleIncomingMessage(msg);
      } catch {
        addLog("RX", "unknown", String(e.data).substring(0, 80));
      }
    };

    ws.onclose = (e) => {
      addLog("SYS", "stop", `code=${e.code} reason=${e.reason || "none"}`);
      cleanup();
    };

    ws.onerror = (e) => {
      addLog("SYS", "error", `WebSocket error → ${url}`);
      console.error("WebSocket error:", e, "url:", url);
    };
  };

  const handleIncomingMessage = (msg) => {
    const now = performance.now();
    switch (msg.event) {
      case "media": {
        if (!playerRef.current) playerRef.current = new AudioPlayer();
        playerRef.current.enqueue(msg.media.payload);
        recorderRef.current.addRx(msg.media.payload);
        const count = statsRef.current.mediaRecv + 1;
        updateStat("mediaRecv", count);

        if (lastMediaRecvRef.current != null) {
          const interval = Math.round(now - lastMediaRecvRef.current);
          updateStat("recvInterval", interval);
        }
        lastMediaRecvRef.current = now;

        if (statsRef.current.firstMediaLatency == null && firstMediaSentRef.current != null) {
          updateStat("firstMediaLatency", Math.round(now - firstMediaSentRef.current));
        }

        addLog("RX", "media", msg.media.payload.substring(0, 20) + "...");
        break;
      }
      case "mark": {
        const name = msg.mark?.name;
        if (pendingMarksRef.current[name]) {
          const rtt = Math.round(now - pendingMarksRef.current[name]);
          updateStat("markRtt", rtt);
          delete pendingMarksRef.current[name];
          addLog("RX", "mark", `name=${name} RTT=${rtt}ms`);
        } else {
          addLog("RX", "mark", `name=${name}`);
        }
        break;
      }
      case "clear":
        playerRef.current?.clear();
        addLog("RX", "clear", "");
        break;
      default:
        addLog("RX", msg.event || "unknown", JSON.stringify(msg).substring(0, 80));
    }
  };

  // --- Mic Streaming ---

  const startStreaming = async () => {
    const mic = new MicCapture((base64Payload) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        mediaTimestampRef.current += 20;
        const msg = buildMedia(streamSidRef.current, base64Payload, mediaTimestampRef.current);
        wsRef.current.send(msg);
        recorderRef.current.addTx(base64Payload);
        const count = statsRef.current.mediaSent + 1;
        updateStat("mediaSent", count);

        if (firstMediaSentRef.current == null) {
          firstMediaSentRef.current = performance.now();
        }
      }
    });
    await mic.start();
    micRef.current = mic;

    if (mic.analyser) {
      micAnalyserRef.current = mic.analyser;
      micAnalyserDataRef.current = new Uint8Array(mic.analyser.frequencyBinCount);
    }

    mediaTimestampRef.current = 0;
    firstMediaSentRef.current = null;
    startTimeRef.current = Date.now();
    setStatus(STATUS.STREAMING);
    addLog("SYS", "start", "Mic streaming started");

    if (autoRecord && !recording) {
      recorderRef.current.start();
      setRecording(true);
      addLog("SYS", "start", "Auto-recording started");
    }

    durationIntervalRef.current = setInterval(() => {
      if (startTimeRef.current) {
        const sec = Math.round((Date.now() - startTimeRef.current) / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        updateStat("duration", `${m}:${s.toString().padStart(2, "0")}`);
      }
    }, 1000);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    micRef.current?.setMuted(next);
    addLog("SYS", next ? "stop" : "start", next ? "Muted" : "Unmuted");
  };

  // --- Controls ---

  const sendDtmf = (digit) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(buildDtmf(streamSidRef.current, digit));
    addLog("TX", "dtmf", `digit=${digit}`);
  };

  const sendMark = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    pendingMarksRef.current[markName] = performance.now();
    wsRef.current.send(buildMark(streamSidRef.current, markName));
    addLog("TX", "mark", `name=${markName}`);
    setMarkName(`ping-${Date.now() % 10000}`);
  };

  const sendClear = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(buildClear(streamSidRef.current));
    playerRef.current?.clear();
    addLog("TX", "clear", "");
  };

  const sendStop = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(buildStop(callId, streamSidRef.current));
    addLog("TX", "stop", "");
    wsRef.current.close();
  };

  const cleanup = () => {
    clearInterval(durationIntervalRef.current);
    micRef.current?.stop();
    micRef.current = null;
    micAnalyserRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    wsRef.current = null;
    lastMediaRecvRef.current = null;
    firstMediaSentRef.current = null;
    if (recorderRef.current.recording) {
      recorderRef.current.stop();
      if (recorderRef.current.hasData) {
        const now = new Date();
        const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const dd = String(ist.getDate()).padStart(2, "0");
        const mmm = ist.toLocaleString("en-US", { month: "short" });
        const hh = String(ist.getHours()).padStart(2, "0");
        const mm = String(ist.getMinutes()).padStart(2, "0");
        recorderRef.current.download(`${callId}_${dd}-${mmm}_${hh}-${mm}.wav`);
      }
    }
    setRecording(false);
    setStatus(STATUS.DISCONNECTED);
    setMuted(false);
  };

  const handleDisconnect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      sendStop();
    } else {
      cleanup();
    }
  };

  const checkHealth = async () => {
    try {
      const res = await fetch(`${backendUrl}/health`);
      const data = await res.json();
      setHealthStatus(data);
    } catch (err) {
      setHealthStatus({ status: "error", error: err.message });
    }
  };

  const getMicWaveform = useCallback(() => {
    if (!micAnalyserRef.current || !micAnalyserDataRef.current) return null;
    micAnalyserRef.current.getByteTimeDomainData(micAnalyserDataRef.current);
    return micAnalyserDataRef.current;
  }, []);

  const getPlayerWaveform = useCallback(() => {
    return playerRef.current?.getAnalyserData() || null;
  }, []);

  const isConnected = status >= STATUS.CONNECTED;
  const isStreaming = status === STATUS.STREAMING;

  return (
    <div className="app">
      <header>
        <h1>SmartFlo Playground</h1>
        <div className="status-bar">
          <span className="status-dot" style={{ backgroundColor: STATUS_COLORS[status] }} />
          <span>{STATUS_LABELS[status]}</span>
          <button className="btn-sm" onClick={checkHealth}>Health</button>
          {healthStatus && (
            <span className={`health ${healthStatus.status === "ok" ? "health-ok" : "health-err"}`}>
              {healthStatus.status === "ok" ? "OK" : healthStatus.error}
            </span>
          )}
          <button
            className="btn-sm"
            onClick={() => {
              if (adminToken) {
                setShowAdmin(!showAdmin);
              } else {
                setShowAdmin(true);
              }
            }}
          >
            {showAdmin ? "Close Admin" : "Admin"}
          </button>
          {adminToken && (
            <button className="btn-sm" onClick={handleAdminLogout}>Logout</button>
          )}
        </div>
      </header>

      {showAdmin && (
        <AdminPanel
          adminToken={adminToken}
          backendUrl={backendUrl}
          onLogin={handleAdminLogin}
          onClose={() => setShowAdmin(false)}
          onProvidersChanged={fetchProviders}
        />
      )}

      <div className="main-grid">
        <div className="left-col">
          <section className="card">
            <h3>Session</h3>
            <div className="form-grid">
              <label>Backend URL</label>
              <input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} disabled={isConnected} />
              <label>Provider</label>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                disabled={isConnected}
              >
                {providers.length === 0 && <option value="">
                  {providersLoading ? "Loading..." : "No providers (use .env defaults)"}
                </option>}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.display_name}</option>
                ))}
              </select>
              <label>Call ID</label>
              <input value={callId} onChange={(e) => setCallId(e.target.value)} disabled={isConnected} />
              <label>From</label>
              <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} disabled={isConnected} />
              <label>To</label>
              <input value={toNumber} onChange={(e) => setToNumber(e.target.value)} disabled={isConnected} />
              <label>Direction</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)} disabled={isConnected}>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
              <label>Agent</label>
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)} disabled={isConnected} placeholder="default from provider" />
            </div>
            {connectUrl && <div className="connect-url">Session: <code>{connectUrl.split("/").pop()}</code></div>}
            <div className="btn-row">
              {!isConnected ? (
                <button className="btn btn-primary" onClick={handleConnect} disabled={status === STATUS.CONNECTING}>
                  Connect
                </button>
              ) : (
                <button className="btn btn-danger" onClick={handleDisconnect}>Disconnect</button>
              )}
              {isConnected && !isStreaming && (
                <button className="btn btn-primary" onClick={startStreaming}>Start Mic</button>
              )}
              {isStreaming && (
                <button className={`btn ${muted ? "btn-warning" : "btn-secondary"}`} onClick={toggleMute}>
                  {muted ? "Unmute" : "Mute"}
                </button>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h3>Audio</h3>
              <label className="auto-record-toggle">
                <input type="checkbox" checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} />
                Auto Record
              </label>
            </div>
            <div className="waveforms">
              <Waveform analyserGetter={getMicWaveform} label="Mic (TX)" color="#60a5fa" />
              <Waveform analyserGetter={getPlayerWaveform} label="Speaker (RX)" color="#4ade80" />
            </div>
          </section>

          <section className="card">
            <h3>Controls</h3>
            <DtmfKeypad onPress={sendDtmf} disabled={!isConnected} />
            <div className="control-row">
              <input value={markName} onChange={(e) => setMarkName(e.target.value)} placeholder="mark name" className="mark-input" />
              <button className="btn btn-sm" onClick={sendMark} disabled={!isConnected}>Mark</button>
              <button className="btn btn-sm btn-warning" onClick={sendClear} disabled={!isConnected}>Clear</button>
            </div>
          </section>
        </div>

        <div className="right-col">
          <LatencyPanel stats={stats} />
          <EventLog entries={logs} />
        </div>
      </div>
    </div>
  );
}
