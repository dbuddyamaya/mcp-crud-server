import { useState, useEffect } from "react";

const BACKEND_URL = "https://mcp-crud-server.onrender.com";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [tools, setTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/status`);
      const data = await res.json();
      setConnected(data.connected);
      setTools(data.tools || []);
    } catch {
      setConnected(false);
    }
  }

  function selectTool(tool) {
    setSelectedTool(tool);
    setResult(null);
    setError(null);
    const props = tool.inputSchema?.properties || {};
    const scaffold = Object.fromEntries(Object.keys(props).map((k) => [k, ""]));
    setArgsText(JSON.stringify(scaffold, null, 2));
  }

  async function handleRun() {
    if (!selectedTool) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parsedArgs = JSON.parse(argsText);
      const res = await fetch(`${BACKEND_URL}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: selectedTool.name,
          arguments: parsedArgs,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Tool call failed");
      setResult(data.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!connected) {
    return (
      <div style={styles.centerScreen}>
        <div style={styles.centerBox}>
          <div style={styles.title}>MCP Tool Runner</div>
          <p style={{ color: "#4b5568", fontSize: 13 }}>
            Not connected to the backend yet. Make sure{" "}
            <code>http-server.js</code> is running:
          </p>
          <pre style={styles.codeBlock}>node http-server.js</pre>
          <button style={styles.primaryBtn} onClick={fetchStatus}>
            Retry connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div>
          <div style={styles.title}>MCP Tool Runner</div>
          <div style={styles.subtitle}>mcp-crud-server</div>
        </div>
        <div style={styles.statusRow}>
          <span style={{ ...styles.statusDot, background: "#1f6f5c" }} />
          <span style={styles.statusText}>
            Connected · {tools.length} tools
          </span>
        </div>
      </header>

      <div style={styles.main}>
        <aside style={styles.sidebar}>
          {tools.map((tool) => (
            <button
              key={tool.name}
              style={{
                ...styles.toolBtn,
                ...(selectedTool?.name === tool.name
                  ? styles.toolBtnActive
                  : {}),
              }}
              onClick={() => selectTool(tool)}
            >
              {tool.name}
            </button>
          ))}
        </aside>

        <section style={styles.panel}>
          {!selectedTool && (
            <div style={styles.placeholder}>Select a tool from the left.</div>
          )}

          {selectedTool && (
            <>
              <h2 style={styles.toolName}>{selectedTool.name}</h2>
              <p style={styles.toolDesc}>{selectedTool.description}</p>

              <label style={styles.label}>Arguments (JSON)</label>
              <textarea
                style={styles.textarea}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={6}
              />

              <button
                style={styles.primaryBtn}
                onClick={handleRun}
                disabled={loading}
              >
                {loading ? "Running…" : "Run tool"}
              </button>

              {error && <div style={styles.error}>{error}</div>}

              {result && (
                <div style={styles.resultBox}>
                  <div style={styles.resultLabel}>Result</div>
                  <pre style={styles.pre}>
                    {result.content?.map((c) => c.text).join("\n") ??
                      JSON.stringify(result, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const styles = {
  app: {
    fontFamily: "Inter, -apple-system, sans-serif",
    color: "#1a2233",
    background: "#f6f7f9",
    minHeight: "100vh",
  },
  centerScreen: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "#f6f7f9",
  },
  centerBox: {
    maxWidth: 420,
    padding: 24,
    background: "#fff",
    border: "1px solid #dde1e8",
    borderRadius: 10,
    textAlign: "center",
  },
  codeBlock: {
    background: "#1a2233",
    color: "#e6f0ed",
    padding: "8px 12px",
    borderRadius: 6,
    fontSize: 13,
    margin: "12px 0",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 24px",
    borderBottom: "1px solid #dde1e8",
    background: "#fff",
  },
  title: { fontWeight: 600, fontSize: 16 },
  subtitle: { fontFamily: "monospace", fontSize: 12, color: "#4b5568" },
  statusRow: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: "50%" },
  statusText: { fontSize: 13, color: "#4b5568" },
  label: { display: "block", fontSize: 12, color: "#4b5568", marginBottom: 6 },
  primaryBtn: {
    background: "#1f6f5c",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  error: {
    marginTop: 12,
    padding: "8px 12px",
    background: "#fdecea",
    color: "#7a2e25",
    borderRadius: 6,
    fontSize: 13,
    fontFamily: "monospace",
  },
  main: { display: "flex", height: "calc(100vh - 61px)" },
  sidebar: {
    width: 240,
    borderRight: "1px solid #dde1e8",
    background: "#fff",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    overflowY: "auto",
  },
  toolBtn: {
    textAlign: "left",
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontFamily: "monospace",
    cursor: "pointer",
    color: "#1a2233",
  },
  toolBtnActive: { background: "#e6f0ed", color: "#1f6f5c", fontWeight: 600 },
  panel: { flex: 1, padding: 24, overflowY: "auto" },
  placeholder: { color: "#4b5568", fontSize: 14 },
  toolName: { margin: "0 0 4px", fontFamily: "monospace", fontSize: 18 },
  toolDesc: { color: "#4b5568", fontSize: 13, marginBottom: 16 },
  textarea: {
    width: "100%",
    padding: 10,
    border: "1px solid #dde1e8",
    borderRadius: 6,
    fontFamily: "monospace",
    fontSize: 12,
    marginBottom: 12,
    boxSizing: "border-box",
  },
  resultBox: {
    marginTop: 20,
    border: "1px solid #dde1e8",
    borderRadius: 8,
    background: "#fff",
  },
  resultLabel: {
    padding: "8px 12px",
    borderBottom: "1px solid #dde1e8",
    fontSize: 12,
    color: "#4b5568",
    fontWeight: 600,
  },
  pre: {
    margin: 0,
    padding: 16,
    fontSize: 12,
    fontFamily: "monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 500,
    overflowY: "auto",
  },
};
