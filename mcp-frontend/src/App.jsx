import { useState, useEffect, useRef } from "react";

// const BACKEND_URL = "http://localhost:3001";

const BACKEND_URL = "https://mcp-crud-server.onrender.com";

function getSessionId() {
  let id = sessionStorage.getItem("mcp_chat_session_id");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mcp_chat_session_id", id);
  }
  return id;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const threadRef = useRef(null);
  const sessionId = useRef(getSessionId());

  useEffect(() => {
    checkStatus();
  }, []);

  useEffect(() => {
    if (threadRef.current)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  async function checkStatus() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/status`);
      const data = await res.json();
      setConnected(data.connected);
      setToolCount((data.tools || []).length);
    } catch {
      setConnected(false);
    }
  }

  async function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setMessages((m) => [...m, { role: "user", kind: "text", content: text }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId.current, message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");

      const newMsgs = data.events
        .map((ev) => {
          if (ev.type === "text")
            return { role: "assistant", kind: "text", content: ev.text };
          if (ev.type === "tool_call")
            return {
              role: "assistant",
              kind: "tool_call",
              name: ev.name,
              input: ev.input,
            };
          return null;
        })
        .filter(Boolean);

      setMessages((m) => [...m, ...newMsgs]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", kind: "error", content: err.message },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    await fetch(`${BACKEND_URL}/api/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId.current }),
    });
    setMessages([]);
  }

  if (!connected) {
    return (
      <div style={styles.centerScreen}>
        <div style={styles.centerBox}>
          <div style={styles.title}>MCP Chat</div>
          <p style={{ color: "#4b5568", fontSize: 13 }}>
            Not connected to the backend.
          </p>
          <button style={styles.primaryBtn} onClick={checkStatus}>
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
          <div style={styles.title}>MCP Chat</div>
          <div style={styles.subtitle}>mcp-crud-server · {toolCount} tools</div>
        </div>
        <button style={styles.resetBtn} onClick={handleReset}>
          New session
        </button>
      </header>

      <div style={styles.thread} ref={threadRef}>
        {messages.length === 0 && (
          <div style={styles.welcome}>
            Ask about the data — e.g. "What tables are available?" or "Show me 5
            rows from claims_physicians_by_specialty."
          </div>
        )}
        {messages.map((m, i) => {
          if (m.kind === "tool_call") {
            return (
              <div key={i} style={styles.toolCall}>
                <span style={{ color: "#1f6f5c", fontWeight: 600 }}>
                  {m.name}
                </span>{" "}
                {JSON.stringify(m.input)}
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                ...styles.msg,
                ...(m.role === "user" ? styles.msgUser : styles.msgAssistant),
                ...(m.kind === "error" ? styles.msgError : {}),
              }}
            >
              {m.content}
            </div>
          );
        })}
        {loading && <div style={styles.thinking}>thinking…</div>}
      </div>

      <form style={styles.composer} onSubmit={handleSend}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about the data…"
        />
        <button style={styles.primaryBtn} type="submit" disabled={loading}>
          Send
        </button>
      </form>
    </div>
  );
}

const styles = {
  app: {
    fontFamily: "Inter, -apple-system, sans-serif",
    color: "#1a2233",
    background: "#f6f7f9",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
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
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: "1px solid #dde1e8",
    background: "#fff",
  },
  title: { fontWeight: 600, fontSize: 16 },
  subtitle: { fontFamily: "monospace", fontSize: 12, color: "#4b5568" },
  resetBtn: {
    background: "transparent",
    border: "1px solid #dde1e8",
    color: "#4b5568",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  thread: {
    flex: 1,
    overflowY: "auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxWidth: 880,
    width: "100%",
    margin: "0 auto",
    boxSizing: "border-box",
  },
  welcome: {
    color: "#4b5568",
    fontSize: 14,
    border: "1px dashed #dde1e8",
    borderRadius: 10,
    padding: 16,
    background: "#fff",
  },
  msg: {
    maxWidth: "88%",
    padding: "10px 14px",
    borderRadius: 10,
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  msgUser: { alignSelf: "flex-end", background: "#1f6f5c", color: "#fff" },
  msgAssistant: {
    alignSelf: "flex-start",
    background: "#fff",
    border: "1px solid #dde1e8",
  },
  msgError: {
    background: "#fdecea",
    color: "#7a2e25",
    border: "1px solid #f3c8c3",
  },
  toolCall: {
    alignSelf: "flex-start",
    fontFamily: "monospace",
    fontSize: 11.5,
    color: "#4b5568",
    background: "#e6f0ed",
    borderRadius: 6,
    padding: "6px 10px",
    maxWidth: "88%",
  },
  thinking: {
    alignSelf: "flex-start",
    fontFamily: "monospace",
    fontSize: 12,
    color: "#4b5568",
  },
  composer: {
    display: "flex",
    gap: 10,
    padding: "14px 20px 20px",
    borderTop: "1px solid #dde1e8",
    background: "#fff",
    maxWidth: 880,
    width: "100%",
    margin: "0 auto",
    boxSizing: "border-box",
  },
  input: {
    flex: 1,
    padding: "10px 12px",
    border: "1px solid #dde1e8",
    borderRadius: 8,
    fontSize: 14,
  },
  primaryBtn: {
    background: "#1f6f5c",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "0 20px",
    fontSize: 14,
    cursor: "pointer",
  },
};
