import { useEffect, useRef, useState, useCallback } from "react";
import "./LiveLogs.css";

const TYPE_COLORS = {
  connect: "#4ade80",
  disconnect: "#f87171",
  warning: "#fbbf24",
  event: "#60a5fa",
};

const EVENT_COLORS = {
  connected: "#60a5fa",
  start: "#a78bfa",
  media: "#6b7280",
  dtmf: "#fbbf24",
  stop: "#f87171",
  mark: "#34d399",
  clear: "#fb923c",
};

function fmtTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-US", {
    hour12: false,
    fractionalSecondDigits: 3,
  });
}

function summarize(entry) {
  if (entry.type !== "event") return "";
  const d = entry.detail;
  if (!d) return "";
  if (entry.event === "media") {
    return `chunk=${d.chunk} bytes=${d.payload_bytes}`;
  }
  return JSON.stringify(d).slice(0, 160);
}

export default function LiveLogs() {
  const [backendUrl, setBackendUrl] = useState(() => window.location.origin);
  const [monitorStatus, setMonitorStatus] = useState("connecting"); // connecting | live | reconnecting | error
  const [healthOk, setHealthOk] = useState(null); // null | true | false
  const [activeConnections, setActiveConnections] = useState(0);
  const [entries, setEntries] = useState([]);
  const [paused, setPaused] = useState(false);

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const bottomRef = useRef(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const addEntry = useCallback((entry) => {
    setEntries((prev) => {
      const next = [...prev, entry];
      return next.length > 500 ? next.slice(-300) : next;
    });
    if (entry.type === "connect") setActiveConnections((n) => n + 1);
    if (entry.type === "disconnect") setActiveConnections((n) => Math.max(0, n - 1));
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/health`);
      setHealthOk(res.ok);
    } catch {
      setHealthOk(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const scheme = backendUrl.startsWith("https") ? "wss" : "ws";
      const host = backendUrl.replace(/^https?:\/\//, "");
      const url = `${scheme}://${host}/ws/smartflo-test/logs`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setMonitorStatus("connecting");

      ws.onopen = () => setMonitorStatus("live");

      ws.onmessage = (e) => {
        try {
          addEntry(JSON.parse(e.data));
        } catch {
          // ignore malformed broadcast frames
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setMonitorStatus("reconnecting");
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => setMonitorStatus("error");
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [backendUrl, addEntry]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, paused]);

  const clearLog = () => setEntries([]);

  const statusLabel = {
    connecting: "Connecting...",
    live: "Live",
    reconnecting: "Reconnecting...",
    error: "Error",
  }[monitorStatus];

  const statusColor = {
    connecting: "#fbbf24",
    live: "#4ade80",
    reconnecting: "#fbbf24",
    error: "#f87171",
  }[monitorStatus];

  return (
    <div className="live-logs-app">
      <header>
        <h1>SmartFlo Live Monitor</h1>
        <div className="status-row">
          <span className="status-item">
            <span className="dot" style={{ backgroundColor: statusColor }} />
            Monitor: {statusLabel}
          </span>
          <span className="status-item">
            <span
              className="dot"
              style={{ backgroundColor: healthOk === null ? "#94a3b8" : healthOk ? "#4ade80" : "#f87171" }}
            />
            Backend: {healthOk === null ? "checking..." : healthOk ? "OK" : "unreachable"}
          </span>
          <span className="status-item">Active connections: {activeConnections}</span>
        </div>
      </header>

      <div className="config-row">
        <label>Backend URL</label>
        <input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} />
        <button className="btn-sm" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume auto-scroll" : "Pause auto-scroll"}
        </button>
        <button className="btn-sm" onClick={clearLog}>
          Clear
        </button>
      </div>

      <div className="log-scroll">
        {entries.length === 0 && <div className="empty-hint">Waiting for SmartFlo to connect to /ws/smartflo-test...</div>}
        {entries.map((e, i) => (
          <div
            key={i}
            className="log-entry"
            style={{ borderLeftColor: EVENT_COLORS[e.event] || TYPE_COLORS[e.type] || "#9ca3af" }}
          >
            <span className="log-time">{fmtTime(e.timestamp)}</span>
            <span className="log-client">{e.client}</span>
            <span className="log-type" style={{ color: TYPE_COLORS[e.type] }}>
              {e.type === "event" ? e.event : e.type}
            </span>
            <span className="log-detail">{e.type === "warning" ? e.raw : summarize(e)}</span>
            {e.type === "disconnect" && <span className="log-detail">code={e.code}</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
