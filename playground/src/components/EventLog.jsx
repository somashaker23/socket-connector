import { useEffect, useRef } from "react";

const EVENT_COLORS = {
  connected: "#60a5fa",
  start: "#a78bfa",
  media: "#6b7280",
  dtmf: "#fbbf24",
  stop: "#f87171",
  mark: "#34d399",
  clear: "#fb923c",
  unknown: "#9ca3af",
};

export default function EventLog({ entries }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  return (
    <div className="event-log">
      <h3>Event Log</h3>
      <div className="event-log-scroll">
        {entries.map((e, i) => (
          <div key={i} className="event-entry" style={{ borderLeftColor: EVENT_COLORS[e.event] || EVENT_COLORS.unknown }}>
            <span className="event-time">{e.time}</span>
            <span className="event-dir">{e.dir}</span>
            <span className="event-type" style={{ color: EVENT_COLORS[e.event] || EVENT_COLORS.unknown }}>
              {e.event}
            </span>
            {e.detail && <span className="event-detail">{e.detail}</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
