import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "mcp_admin_creds";

// ── storage helpers ─────────────────────────────────────────────────────
// Credentials are kept client-side only (never baked into the build), so
// the admin token never ends up in a bundle a user's browser can inspect
// as source. Remembering it in localStorage is a convenience for an
// internal, single-admin tool — "Disconnect" below clears it, and anyone
// with access to this browser profile would be able to read it back out.
function loadSavedCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveCreds(creds) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
  } catch {
    /* ignore */
  }
}
function clearCreds() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

async function adminFetch(backendUrl, token, path, opts = {}) {
  const res = await fetch(`${backendUrl}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...opts.headers,
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty/non-JSON body */
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.error) || `Request failed (HTTP ${res.status})`,
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

function formatTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function isoDateTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── App shell ────────────────────────────────────────────────────────────
export default function AdminApp() {
  const [creds, setCreds] = useState(null); // { backendUrl, token }
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState("accounts");

  // Accounts are shared across tabs: the Accounts tab manages them, and
  // the Billing tab's drill-down needs each account's username to fetch
  // that one account's activity.
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");

  useEffect(() => {
    const saved = loadSavedCreds();
    if (!saved) {
      setChecking(false);
      return;
    }
    adminFetch(saved.backendUrl, saved.token, "/admin/accounts")
      .then(() => setCreds(saved))
      .catch(() => clearCreds())
      .finally(() => setChecking(false));
  }, []);

  const loadAccounts = useCallback(
    async (activeCreds) => {
      const c = activeCreds || creds;
      if (!c) return;
      setAccountsLoading(true);
      setAccountsError("");
      try {
        const data = await adminFetch(c.backendUrl, c.token, "/admin/accounts");
        setAccounts(data.accounts || []);
      } catch (err) {
        if (err.status === 401) return handleDisconnect();
        setAccountsError(err.message);
      } finally {
        setAccountsLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [creds],
  );

  useEffect(() => {
    if (creds) loadAccounts(creds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds]);

  function handleConnected(next) {
    saveCreds(next);
    setCreds(next);
  }

  function handleDisconnect() {
    clearCreds();
    setCreds(null);
    setAccounts([]);
  }

  if (checking) {
    return (
      <div className="admin-login-screen">
        <div className="admin-loading">Checking saved connection…</div>
      </div>
    );
  }

  if (!creds) {
    return <ConnectScreen onConnected={handleConnected} />;
  }

  return (
    <div className="admin-shell">
      <header className="admin-masthead">
        <div>
          <h1>
            <span className="dot" />
            MCP Admin
          </h1>
          <div className="backend-url">{creds.backendUrl}</div>
        </div>
        <div className="right">
          <button className="admin-btn admin-btn-small" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <nav className="admin-tabs">
        <button
          className={`admin-tab-btn ${tab === "accounts" ? "active" : ""}`}
          onClick={() => setTab("accounts")}
        >
          Accounts
        </button>
        <button
          className={`admin-tab-btn ${tab === "billing" ? "active" : ""}`}
          onClick={() => setTab("billing")}
        >
          Billing
        </button>
        <button
          className={`admin-tab-btn ${tab === "activity" ? "active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
      </nav>

      {tab === "accounts" && (
        <AccountsPanel
          creds={creds}
          accounts={accounts}
          loading={accountsLoading}
          error={accountsError}
          reload={loadAccounts}
          onAuthError={handleDisconnect}
        />
      )}
      {tab === "billing" && (
        <BillingPanel
          creds={creds}
          accounts={accounts}
          onAuthError={handleDisconnect}
        />
      )}
      {tab === "activity" && (
        <ActivityPanel creds={creds} onAuthError={handleDisconnect} />
      )}
    </div>
  );
}

// ── Connect screen ──────────────────────────────────────────────────────
function ConnectScreen({ onConnected }) {
  const [backendUrl, setBackendUrl] = useState("");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!backendUrl.trim() || !token.trim()) return;
    setLoading(true);
    setError("");
    const url = normalizeBaseUrl(backendUrl);
    try {
      await adminFetch(url, token.trim(), "/admin/accounts");
      const next = { backendUrl: url, token: token.trim() };
      if (remember) saveCreds(next);
      onConnected(next);
    } catch (err) {
      setError(
        err.status === 401
          ? "That admin token was rejected by the server."
          : `Couldn't reach the server: ${err.message}`,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login-screen">
      <div className="admin-login-card">
        <h1>MCP Admin</h1>
        <p>
          Connect to your MCP server's admin endpoints to view accounts,
          billing, and activity.
        </p>
        {error && <div className="admin-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="admin-field">
            <label htmlFor="backendUrl">Server URL</label>
            <input
              id="backendUrl"
              className="admin-input"
              placeholder="https://your-service.onrender.com"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div className="admin-field">
            <label htmlFor="adminToken">Admin token</label>
            <input
              id="adminToken"
              className="admin-input"
              type="password"
              placeholder="x-admin-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <label className="admin-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember on this device
          </label>
          <button className="admin-btn admin-btn-primary" disabled={loading}>
            {loading ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Accounts tab ─────────────────────────────────────────────────────────
function AccountsPanel({ creds, accounts, loading, error, reload, onAuthError }) {
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    username: "",
    password: "",
    is_admin: false,
  });
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleteError, setDeleteError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.username.trim() || !form.password) return;
    setFormLoading(true);
    setFormError("");
    try {
      await adminFetch(creds.backendUrl, creds.token, "/admin/accounts", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ name: "", username: "", password: "", is_admin: false });
      setFormOpen(false);
      await reload();
    } catch (err) {
      if (err.status === 401) return onAuthError();
      setFormError(err.message);
    } finally {
      setFormLoading(false);
    }
  }

  async function patchAccount(account, patch) {
    setPendingId(account.id);
    try {
      await adminFetch(
        creds.backendUrl,
        creds.token,
        `/admin/accounts/${account.id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      await reload();
    } catch (err) {
      if (err.status === 401) return onAuthError();
    } finally {
      setPendingId(null);
    }
  }

  const toggleActive = (account) =>
    patchAccount(account, { active: !account.active });
  const toggleAdmin = (account) =>
    patchAccount(account, { is_admin: !account.is_admin });

  async function handleDelete(account) {
    setPendingId(account.id);
    setDeleteError("");
    try {
      await adminFetch(
        creds.backendUrl,
        creds.token,
        `/admin/accounts/${account.id}`,
        { method: "DELETE" },
      );
      setConfirmDeleteId(null);
      await reload();
    } catch (err) {
      if (err.status === 401) return onAuthError();
      setDeleteError(err.message);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <h2>Client accounts</h2>
        <button
          className="admin-btn admin-btn-small"
          onClick={() => setFormOpen((v) => !v)}
        >
          {formOpen ? "Cancel" : "+ New account"}
        </button>
      </div>

      {formOpen && (
        <form onSubmit={handleCreate} style={{ marginBottom: 18 }}>
          {formError && <div className="admin-error">{formError}</div>}
          <div className="admin-form-row">
            <div className="admin-field">
              <label>Client name</label>
              <input
                className="admin-input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Acme Inc."
              />
            </div>
            <div className="admin-field">
              <label>Username</label>
              <input
                className="admin-input"
                value={form.username}
                onChange={(e) =>
                  setForm((f) => ({ ...f, username: e.target.value }))
                }
                placeholder="acme"
              />
            </div>
            <div className="admin-field">
              <label>Password</label>
              <input
                className="admin-input"
                type="password"
                value={form.password}
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="Set a password to hand off"
              />
            </div>
            <button
              className="admin-btn admin-btn-primary"
              style={{ width: "auto" }}
              disabled={formLoading}
            >
              {formLoading ? "Creating…" : "Create"}
            </button>
          </div>
          <label className="admin-remember" style={{ marginTop: 12, marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={form.is_admin}
              onChange={(e) =>
                setForm((f) => ({ ...f, is_admin: e.target.checked }))
              }
            />
            Admin account — excluded from billing
          </label>
        </form>
      )}

      {error && <div className="admin-error">{error}</div>}
      {deleteError && <div className="admin-error">{deleteError}</div>}
      {loading ? (
        <div className="admin-loading">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="admin-empty">No client accounts yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                    {a.username}
                  </td>
                  <td>
                    <span
                      className={`pill ${a.is_admin ? "pill-admin" : "pill-inactive"}`}
                    >
                      <span className="led" />
                      {a.is_admin ? "Admin" : "Client"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`pill ${a.active ? "pill-active" : "pill-inactive"}`}
                    >
                      <span className="led" />
                      {a.active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td>{formatTimestamp(a.created_at)}</td>
                  <td>
                    {confirmDeleteId === a.id ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <span className="hint" style={{ alignSelf: "center" }}>
                          Delete {a.name}?
                        </span>
                        <button
                          className="admin-btn admin-btn-small admin-btn-danger"
                          disabled={pendingId === a.id}
                          onClick={() => handleDelete(a)}
                        >
                          {pendingId === a.id ? "…" : "Confirm"}
                        </button>
                        <button
                          className="admin-btn admin-btn-small"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className="admin-btn admin-btn-small"
                          disabled={pendingId === a.id}
                          onClick={() => toggleActive(a)}
                        >
                          {pendingId === a.id
                            ? "…"
                            : a.active
                              ? "Disable"
                              : "Enable"}
                        </button>
                        <button
                          className="admin-btn admin-btn-small"
                          disabled={pendingId === a.id}
                          onClick={() => toggleAdmin(a)}
                        >
                          {pendingId === a.id
                            ? "…"
                            : a.is_admin
                              ? "Remove admin"
                              : "Make admin"}
                        </button>
                        <button
                          className="admin-btn admin-btn-small admin-btn-danger"
                          disabled={pendingId === a.id}
                          onClick={() => setConfirmDeleteId(a.id)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Billing tab ──────────────────────────────────────────────────────────
function BillingPanel({ creds, accounts, onAuthError }) {
  const [from, setFrom] = useState(isoDateDaysAgo(30));
  const [to, setTo] = useState(isoDateTomorrow());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ from, to });
      const result = await adminFetch(
        creds.backendUrl,
        creds.token,
        `/admin/billing?${params}`,
      );
      setData(result);
    } catch (err) {
      if (err.status === 401) return onAuthError();
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, onAuthError, from, to]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run the report (but keep any drill-down open) when the range changes
  // via the "Run report" button — handled by `run` reading current from/to.

  const totals = data?.totals_by_account || [];
  const byTool = data?.breakdown_by_tool || [];
  const maxCalls = Math.max(1, ...totals.map((t) => Number(t.call_count) || 0));
  const totalCalls = totals.reduce((sum, t) => sum + Number(t.call_count || 0), 0);

  const selectedTotal = totals.find((t) => t.account_id === selectedId);
  const selectedAccount = accounts.find((a) => a.id === selectedId);
  const selectedToolRows = byTool.filter((r) => r.account_id === selectedId);

  if (selectedId && selectedTotal) {
    return (
      <div className="admin-card">
        <AccountDetail
          creds={creds}
          account={
            selectedAccount || {
              id: selectedId,
              name: selectedTotal.account_name,
              username: null,
              active: true,
            }
          }
          deleted={!!selectedTotal.account_deleted}
          totalCalls={Number(selectedTotal.call_count) || 0}
          toolRows={selectedToolRows}
          range={{ from, to }}
          onBack={() => setSelectedId(null)}
          onAuthError={onAuthError}
        />
      </div>
    );
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <h2>Billing report</h2>
        <span className="hint">
          Counts tool calls (method = tools/call) · admin accounts excluded
        </span>
      </div>

      <div className="admin-toolbar">
        <div className="admin-field">
          <label>From</label>
          <input
            type="date"
            className="admin-input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label>To</label>
          <input
            type="date"
            className="admin-input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <button className="admin-btn" onClick={run} disabled={loading}>
          {loading ? "Running…" : "Run report"}
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}

      {loading ? (
        <div className="admin-loading">Loading billing data…</div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat-tile">
              <div className="label">Total tool calls</div>
              <div className="value">{totalCalls.toLocaleString()}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Accounts with usage</div>
              <div className="value">{totals.length}</div>
            </div>
          </div>

          {totals.length === 0 ? (
            <div className="admin-empty">No tool calls in this range.</div>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                Click an account to drill in.
              </div>
              <div className="bar-list" style={{ marginBottom: 24 }}>
                {totals.map((t) => {
                  const count = Number(t.call_count) || 0;
                  const pct = Math.max(2, (count / maxCalls) * 100);
                  return (
                    <button
                      type="button"
                      className="bar-row bar-row-btn"
                      key={t.account_id || t.account_name}
                      onClick={() => setSelectedId(t.account_id)}
                    >
                      <div
                        className="bar-name"
                        title={
                          t.account_deleted
                            ? `${t.account_name} (deleted)`
                            : t.account_name
                        }
                      >
                        {t.account_name || "(unknown)"}
                        {t.account_deleted && (
                          <span className="deleted-tag">deleted</span>
                        )}
                      </div>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="bar-count">{count.toLocaleString()}</div>
                    </button>
                  );
                })}
              </div>

              <div className="table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Tool</th>
                      <th>Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byTool.map((row, i) => (
                      <tr
                        key={`${row.account_id}-${row.tool}-${i}`}
                        className="clickable-row"
                        onClick={() => setSelectedId(row.account_id)}
                      >
                        <td>
                          {row.account_name || "(unknown)"}
                          {row.account_deleted && (
                            <span className="deleted-tag">deleted</span>
                          )}
                        </td>
                        <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                          {row.tool || "—"}
                        </td>
                        <td>{Number(row.call_count).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Billing drill-down: one account's detail ──────────────────────────────
function AccountDetail({ creds, account, deleted, totalCalls, toolRows, range, onBack, onAuthError }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(!!account.username);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!account.username) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ username: account.username, limit: "50" });
    adminFetch(creds.backendUrl, creds.token, `/admin/activity?${params}`)
      .then((res) => {
        if (!cancelled) setEvents(res.events || []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 401) return onAuthError();
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, account.username]);

  return (
    <div>
      <button className="link-btn" onClick={onBack}>
        ← Back to all accounts
      </button>

      <div className="admin-card-header" style={{ marginTop: 16 }}>
        <h2>{account.name}</h2>
        {deleted ? (
          <span className="pill pill-deleted">
            <span className="led" />
            Deleted
          </span>
        ) : (
          account.username && (
            <span
              className={`pill ${account.active ? "pill-active" : "pill-inactive"}`}
            >
              <span className="led" />
              {account.active ? "Active" : "Disabled"}
            </span>
          )
        )}
      </div>
      {account.username && (
        <div className="hint" style={{ marginBottom: 16, fontFamily: "IBM Plex Mono, monospace" }}>
          {account.username}
        </div>
      )}
      {deleted && (
        <div className="hint" style={{ marginBottom: 16 }}>
          This account was deleted. Totals below come from its usage history —
          usage_events keeps a name snapshot even after the account is gone.
        </div>
      )}

      <div className="stat-row">
        <div className="stat-tile">
          <div className="label">Calls, {range.from} – {range.to}</div>
          <div className="value">{totalCalls.toLocaleString()}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Distinct tools used</div>
          <div className="value">{toolRows.length}</div>
        </div>
      </div>

      {toolRows.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, margin: "0 0 10px" }}>By tool</h3>
          <div className="table-scroll" style={{ marginBottom: 22 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                </tr>
              </thead>
              <tbody>
                {toolRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                      {r.tool || "—"}
                    </td>
                    <td>{Number(r.call_count).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 style={{ fontSize: 13, margin: "0 0 10px" }}>Recent activity (all time)</h3>
      {!account.username ? (
        <div className="admin-empty">
          {deleted
            ? "This account no longer exists, so its username can't be looked up — check the Activity tab's raw feed instead."
            : "This account's username wasn't available to look up its activity."}
        </div>
      ) : error ? (
        <div className="admin-error">{error}</div>
      ) : loading ? (
        <div className="admin-loading">Loading activity…</div>
      ) : events.length === 0 ? (
        <div className="admin-empty">No recorded activity for this account.</div>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Method</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => {
                const ok = String(ev.status).startsWith("2");
                return (
                  <tr key={i}>
                    <td>{formatTimestamp(ev.timestamp)}</td>
                    <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                      {ev.method || "—"}
                    </td>
                    <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                      {ev.tool || "—"}
                    </td>
                    <td className={ok ? "pill-status-ok" : "pill-status-err"}>
                      {ev.status}
                    </td>
                    <td>
                      {ev.duration_ms != null ? `${ev.duration_ms} ms` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Activity tab ─────────────────────────────────────────────────────────
function ActivityPanel({ creds, onAuthError }) {
  const [username, setUsername] = useState("");
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [events, setEvents] = useState([]);
  const [accountLabel, setAccountLabel] = useState(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (username.trim()) params.set("username", username.trim());
      const result = await adminFetch(
        creds.backendUrl,
        creds.token,
        `/admin/activity?${params}`,
      );
      setEvents(result.events || []);
      setAccountLabel(result.account || null);
    } catch (err) {
      if (err.status === 401) return onAuthError();
      setError(err.message);
      setEvents([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, onAuthError, limit]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    run();
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <h2>Activity feed</h2>
        <span className="hint">
          {accountLabel ? `Filtered to ${accountLabel}` : "All accounts"}
        </span>
      </div>

      <form className="admin-toolbar" onSubmit={handleSubmit}>
        <div className="admin-field">
          <label>Username</label>
          <input
            className="admin-input"
            placeholder="(all accounts)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label>Limit</label>
          <select
            className="admin-select"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={100}>100</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
        </div>
        <button className="admin-btn" disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </form>

      {error && <div className="admin-error">{error}</div>}

      {loading ? (
        <div className="admin-loading">Loading activity…</div>
      ) : events.length === 0 ? (
        <div className="admin-empty">No activity found.</div>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                {!accountLabel && <th>Account</th>}
                <th>Method</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => {
                const ok =
                  String(ev.status).startsWith("2") ||
                  String(ev.status) === "200";
                return (
                  <tr key={i}>
                    <td>{formatTimestamp(ev.timestamp)}</td>
                    {!accountLabel && (
                      <td>
                        {ev.account_name || "—"}
                        {ev.account_deleted && ev.account_name && (
                          <span className="deleted-tag">deleted</span>
                        )}
                      </td>
                    )}
                    <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                      {ev.method || "—"}
                    </td>
                    <td style={{ fontFamily: "IBM Plex Mono, monospace" }}>
                      {ev.tool || "—"}
                    </td>
                    <td className={ok ? "pill-status-ok" : "pill-status-err"}>
                      {ev.status}
                    </td>
                    <td>
                      {ev.duration_ms != null ? `${ev.duration_ms} ms` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
