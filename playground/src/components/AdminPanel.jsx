import { useState, useEffect } from "react";

export default function AdminPanel({ adminToken, backendUrl, onLogin, onClose, onProvidersChanged }) {
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);

  // New provider form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ display_name: "", livekit_url: "", livekit_api_key: "", livekit_api_secret: "" });

  useEffect(() => {
    if (adminToken) loadProviders();
  }, [adminToken]);

  const authHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  });

  const loadProviders = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${backendUrl}/admin/providers`, { headers: authHeaders() });
      if (res.status === 401) {
        onLogin && localStorage.removeItem("adminToken");
        return;
      }
      setProviders(await res.json());
    } catch {
      setProviders([]);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      await onLogin(password);
      setPassword("");
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    try {
      if (editId) {
        await fetch(`${backendUrl}/admin/providers/${editId}`, {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify(form),
        });
      } else {
        await fetch(`${backendUrl}/admin/providers`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(form),
        });
      }
      setShowForm(false);
      setEditId(null);
      setForm({ display_name: "", livekit_url: "", livekit_api_key: "", livekit_api_secret: "" });
      await loadProviders();
      onProvidersChanged();
    } catch (err) {
      alert("Failed to save: " + err.message);
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete provider "${name}"?`)) return;
    await fetch(`${backendUrl}/admin/providers/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    await loadProviders();
    onProvidersChanged();
  };

  const startEdit = (p) => {
    setEditId(p.id);
    setForm({
      display_name: p.display_name,
      livekit_url: p.livekit_url,
      livekit_api_key: p.livekit_api_key,
      livekit_api_secret: "",
    });
    setShowForm(true);
  };

  // Not logged in — show login form
  if (!adminToken) {
    return (
      <div className="admin-panel card">
        <div className="card-header">
          <h3>Admin Login</h3>
          <button className="btn-sm" onClick={onClose}>X</button>
        </div>
        <form onSubmit={handleLogin} className="admin-login-form">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            autoFocus
          />
          <button type="submit" className="btn btn-primary">Login</button>
        </form>
        {loginError && <div className="admin-error">{loginError}</div>}
      </div>
    );
  }

  // Logged in — show provider management
  return (
    <div className="admin-panel card">
      <div className="card-header">
        <h3>Provider Management</h3>
        <div style={{ display: "flex", gap: "6px" }}>
          <button className="btn-sm" onClick={() => { setShowForm(true); setEditId(null); setForm({ display_name: "", livekit_url: "", livekit_api_key: "", livekit_api_secret: "" }); }}>
            + Add
          </button>
          <button className="btn-sm" onClick={onClose}>X</button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="provider-form">
          <div className="form-grid">
            <label>Display Name</label>
            <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required />
            <label>Server URL</label>
            <input value={form.livekit_url} onChange={(e) => setForm({ ...form, livekit_url: e.target.value })} placeholder="wss://..." required={!editId} />
            <label>API Key</label>
            <input value={form.livekit_api_key} onChange={(e) => setForm({ ...form, livekit_api_key: e.target.value })} required={!editId} />
            <label>API Secret</label>
            <input
              type="password"
              value={form.livekit_api_secret}
              onChange={(e) => setForm({ ...form, livekit_api_secret: e.target.value })}
              placeholder={editId ? "leave blank to keep" : ""}
              required={!editId}
            />
          </div>
          <div className="btn-row" style={{ marginTop: "8px" }}>
            <button type="submit" className="btn btn-primary btn-sm">{editId ? "Update" : "Create"}</button>
            <button type="button" className="btn-sm" onClick={() => { setShowForm(false); setEditId(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={{ color: "#64748b", fontSize: "12px" }}>Loading...</div>
      ) : providers.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: "12px" }}>No providers configured. Click "+ Add" to create one.</div>
      ) : (
        <table className="provider-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Server URL</th>
              <th>API Key</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name}</td>
                <td className="url-cell">{p.livekit_url}</td>
                <td>{p.livekit_api_key}</td>
                <td>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button className="btn-sm" onClick={() => startEdit(p)}>Edit</button>
                    <button className="btn-sm btn-danger-sm" onClick={() => handleDelete(p.id, p.display_name)}>Del</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
