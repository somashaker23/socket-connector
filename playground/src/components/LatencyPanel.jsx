export default function LatencyPanel({ stats }) {
  return (
    <div className="latency-panel">
      <h3>Latency & Stats</h3>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">Connect API</span>
          <span className="stat-value">{stats.connectLatency != null ? `${stats.connectLatency} ms` : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">WS Handshake</span>
          <span className="stat-value">{stats.wsHandshake != null ? `${stats.wsHandshake} ms` : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Mark RTT</span>
          <span className="stat-value">{stats.markRtt != null ? `${stats.markRtt} ms` : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Media Sent</span>
          <span className="stat-value">{stats.mediaSent}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Media Received</span>
          <span className="stat-value">{stats.mediaRecv}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Recv Interval</span>
          <span className="stat-value">{stats.recvInterval != null ? `${stats.recvInterval} ms` : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Duration</span>
          <span className="stat-value">{stats.duration}</span>
        </div>
        <div className="stat">
          <span className="stat-label">First Media</span>
          <span className="stat-value">{stats.firstMediaLatency != null ? `${stats.firstMediaLatency} ms` : "—"}</span>
        </div>
      </div>
    </div>
  );
}
