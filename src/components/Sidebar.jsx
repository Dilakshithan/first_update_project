// src/components/Sidebar.jsx
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import CodeExtractionPanel from "./CodeExtractionPanel";
import "./Sidebar.css";

const Sidebar = forwardRef(function Sidebar({ videoPlayerRef, roi, isSelectingRoi, onRequestRoiSelect, onCancelRoiSelect, onScanStateChange, extractionMode }, ref) {
  const [activeTab, setActiveTab] = useState("Code");

  // --- Speech / Audio Extraction ---
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechChunks, setSpeechChunks] = useState([]);
  const [speechSearchTerm, setSpeechSearchTerm] = useState("");
  const [speechError, setSpeechError] = useState(null);
  const [speechMode, setSpeechMode] = useState("idle"); // idle|normal|long|over30
  const [speechJobId, setSpeechJobId] = useState(null);
  const [speechJobStatus, setSpeechJobStatus] = useState("Idle");
  const [speechProgress, setSpeechProgress] = useState({
    totalChunks: 0,
    completedChunks: 0,
    currentChunk: 0,
    percent: 0,
    statusText: "",
  });
  const [forceSlowOffline, setForceSlowOffline] = useState(false);

  // --- Copilot Chat ---
  const [copilotMessages, setCopilotMessages] = useState([{ role: 'assistant', content: 'Hi! I am your offline AI Copilot. Ask me anything!' }]);
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotLoading, setCopilotLoading] = useState(false);

  const handleCopilotSend = async () => {
    if (!copilotInput.trim() || copilotLoading) return;
    const userMsg = { role: 'user', content: copilotInput };
    const newMessages = [...copilotMessages, userMsg];
    setCopilotMessages(newMessages);
    setCopilotInput("");
    setCopilotLoading(true);

    try {
      const reply = await window.api.chatCopilot(newMessages);
      setCopilotMessages([...newMessages, { role: 'assistant', content: reply }]);
    } catch (e) {
      console.error(e);
      setCopilotMessages([...newMessages, { role: 'assistant', content: 'Error: ' + e.message }]);
    } finally {
      setCopilotLoading(false);
    }
  };

  useImperativeHandle(ref, () => ({
    autoStartServices: () => {
      // 1. Auto-extract audio if haven't already
      if (!speechLoading && speechChunks.length === 0 && !speechError) {
        handleExtractAudio();
      }
    }
  }), [speechLoading, speechChunks, speechError]);

  useEffect(() => {
    if (!window.api?.onOfflineTranscriptionProgress) return;

    let lastUpdateTime = 0;
    let pendingPayload = null;
    let throttleTimer = null;

    const processPayload = (payload) => {
      const t = payload.type;
      if (t === "job_started") {
        setSpeechJobStatus("Running (long offline)");
        setSpeechProgress((p) => ({
          ...p,
          totalChunks: payload.totalChunks || p.totalChunks,
          completedChunks: payload.completedChunks || 0,
          percent: payload.totalChunks ? Math.round((100 * (payload.completedChunks || 0)) / payload.totalChunks) : 0,
          statusText: "Starting...",
        }));
      } else if (t === "stage") {
        setSpeechProgress((p) => ({ ...p, statusText: payload.stage || p.statusText }));
      } else if (t === "chunk_started") {
        setSpeechProgress((p) => ({
          ...p,
          currentChunk: payload.currentChunk || p.currentChunk,
          totalChunks: payload.totalChunks || p.totalChunks,
          statusText: `Transcribing chunk ${payload.currentChunk || "?"}/${payload.totalChunks || "?"}...`,
        }));
      } else if (t === "chunk_completed") {
        setSpeechProgress((p) => ({
          ...p,
          completedChunks: payload.completedChunks ?? p.completedChunks,
          totalChunks: payload.totalChunks || p.totalChunks,
          percent: payload.percent != null ? Math.round(payload.percent) : p.percent,
          statusText: `Completed ${payload.completedChunks ?? p.completedChunks}/${payload.totalChunks || p.totalChunks}`,
        }));
      } else if (t === "job_paused") {
        setSpeechJobStatus("Paused");
        setSpeechProgress((p) => ({ ...p, statusText: "Paused" }));
        setSpeechLoading(false);
      } else if (t === "job_cancelled") {
        setSpeechJobStatus("Cancelled");
        setSpeechProgress((p) => ({ ...p, statusText: "Cancelled" }));
        setSpeechLoading(false);
      } else if (t === "chunk_failed") {
        setSpeechJobStatus("Running (with errors)");
        setSpeechProgress((p) => ({ ...p, statusText: `Chunk ${payload.chunkIndex} failed (will continue)` }));
      } else if (t === "job_completed") {
        setSpeechJobStatus("Completed");
        setSpeechProgress((p) => ({ ...p, statusText: "Completed" }));
        setSpeechLoading(false);
        // Load segments only once finished (OK to keep in memory for searching)
        if (window.api?.getOfflineTranscriptionSegments && speechJobId) {
          window.api.getOfflineTranscriptionSegments(speechJobId).then((segments) => {
            const mapped = (segments || []).map((s) => ({
              text: s.text || "",
              timestamp: [Number(s.start || 0), Number(s.end || 0)],
              chunkIndex: s.chunkIndex,
            }));
            setSpeechChunks(mapped);
          }).catch((e) => {
            console.error(e);
          });
        }
      }
    };

    const unsubscribe = window.api.onOfflineTranscriptionProgress((payload) => {
      if (!payload) return;
      if (speechJobId && payload.jobId !== speechJobId) return;

      const now = Date.now();
      const isUrgent = ["job_started", "job_completed", "job_paused", "job_cancelled", "chunk_failed"].includes(payload.type);

      // Throttle rapid updates to max 1 per 250ms
      if (isUrgent || now - lastUpdateTime > 250) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        lastUpdateTime = now;
        processPayload(payload);
      } else {
        pendingPayload = payload;
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            lastUpdateTime = Date.now();
            throttleTimer = null;
            if (pendingPayload) {
              processPayload(pendingPayload);
              pendingPayload = null;
            }
          }, 250);
        }
      }
    });

    return () => {
      if (throttleTimer) clearTimeout(throttleTimer);
      unsubscribe && unsubscribe();
    };
  }, [speechJobId]);

  const handleExtractAudio = async () => {
    if (!videoPlayerRef?.current) return;
    const path = videoPlayerRef.current.getVideoPath();
    if (!path) {
      setSpeechError("Video file path not found. Please double check.");
      return;
    }

    setSpeechLoading(true);
    setSpeechError(null);
    setSpeechChunks([]);
    setSpeechMode("idle");
    setSpeechJobStatus("Working...");
    try {
      // Ask main process which offline mode to use (normal/long/over30)
      const jobInfo = await window.api.createOfflineTranscriptionJob({
        videoPath: path,
        chunkSec: 30,
        modelPreset: "balanced",
        enableVad: true,
        allowOver30Min: forceSlowOffline,
      });

      if (jobInfo?.mode === "normal") {
        setSpeechMode("normal");
        setSpeechJobStatus("Running (normal offline)");
        const chunks = await window.api.extractAudio(path);
        setSpeechChunks(chunks || []);
        setSpeechJobStatus("Completed");
      } else if (jobInfo?.mode === "long") {
        setSpeechMode("long");
        setSpeechJobId(jobInfo.jobId);
        setSpeechJobStatus("Queued (long offline)");
        setSpeechProgress((p) => ({
          ...p,
          totalChunks: jobInfo.totalChunks || 0,
          completedChunks: 0,
          currentChunk: 0,
          percent: 0,
          statusText: "Starting worker...",
        }));
        await window.api.startOfflineTranscription(jobInfo.jobId);
      } else if (jobInfo?.mode === "over30") {
        setSpeechMode("over30");
        setSpeechJobStatus("Too long (recommend online)");
        setSpeechError(jobInfo.warning || "Video is longer than 30 minutes. Online mode recommended.");
      } else {
        throw new Error("Unknown transcription mode");
      }
    } catch (err) {
      console.error(err);
      setSpeechError(err.message || "Failed to extract audio");
    } finally {
      // For long jobs we keep loading=true until completion/pause/cancel
      if (speechMode !== "long") setSpeechLoading(false);
    }
  };

  const pauseLongSpeech = async () => {
    if (!speechJobId) return;
    try {
      await window.api.pauseOfflineTranscription(speechJobId);
    } catch (e) {
      console.error(e);
      setSpeechError(e.message || "Pause failed");
    }
  };
  const resumeLongSpeech = async () => {
    if (!speechJobId) return;
    setSpeechLoading(true);
    try {
      await window.api.resumeOfflineTranscription(speechJobId);
    } catch (e) {
      console.error(e);
      setSpeechError(e.message || "Resume failed");
      setSpeechLoading(false);
    }
  };
  const cancelLongSpeech = async () => {
    if (!speechJobId) return;
    try {
      await window.api.cancelOfflineTranscription(speechJobId);
    } catch (e) {
      console.error(e);
      setSpeechError(e.message || "Cancel failed");
    }
  };

  const handleSpeechSeek = (timestamp) => {
    if (!videoPlayerRef?.current || !timestamp) return;
    videoPlayerRef.current.seekTo(timestamp[0]);
  };

  return (
    <div className="sidebar">
      {/* Tab headers */}
      <div className="tabs">
        {["Playlist", "Scene", "Code", "Speech", "Copilot", "Info"].map((tab) => (
          <div
            key={tab}
            className={`tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </div>
        ))}
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === "Code" && (
          <CodeExtractionPanel
            videoPlayerRef={videoPlayerRef}
            roi={roi}
            isSelectingRoi={isSelectingRoi}
            onRequestRoiSelect={onRequestRoiSelect}
            onCancelRoiSelect={onCancelRoiSelect}
            onScanStateChange={onScanStateChange}
            extractionMode={extractionMode}
          />
        )}

        {activeTab === "Speech" && (
          <div className="speech-card">
            <div className="card-title">🎙️ Audio to Text Search</div>
            <div className="card-desc">
              Extract spoken text right from the video to search the timeline.
              <br />
              <i>
                Offline: 0–10 min normal. 10–30 min long mode (chunked background). 30+ min: online recommended.
              </i>
            </div>

            <div style={{ marginTop: 10 }}>
              <button className="extract-btn" onClick={handleExtractAudio} disabled={speechLoading}>
                {speechLoading ? "Processing..." : "▶ Extract Audio to Text (Offline)"}
              </button>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ color: "#9ca3af", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={forceSlowOffline}
                  onChange={(e) => setForceSlowOffline(e.target.checked)}
                  disabled={speechLoading}
                  style={{ marginRight: 6 }}
                />
                Allow slow offline for 30+ minutes (not recommended)
              </label>
              {speechMode === "long" && (
                <>
                  <button className="extract-btn" onClick={pauseLongSpeech} disabled={!speechJobId || !speechLoading}>
                    ⏸ Pause
                  </button>
                  <button className="extract-btn" onClick={resumeLongSpeech} disabled={!speechJobId || speechLoading}>
                    ▶ Resume
                  </button>
                  <button className="extract-btn" onClick={cancelLongSpeech} disabled={!speechJobId}>
                    ✖ Cancel
                  </button>
                </>
              )}
            </div>

            <div style={{ marginTop: 10, color: "#9ca3af", fontSize: 12 }}>
              Status: {speechJobStatus}
              {speechMode === "long" && speechProgress.totalChunks > 0 && (
                <>
                  <br />
                  Progress: {speechProgress.completedChunks}/{speechProgress.totalChunks} (
                  {speechProgress.percent}%){speechProgress.currentChunk ? ` | current ${speechProgress.currentChunk}` : ""}
                  <br />
                  {speechProgress.statusText}
                </>
              )}
            </div>

            {speechError && (
              <div style={{ marginTop: 10, color: "#ef4444", fontSize: 13 }}>
                Error: {speechError}
              </div>
            )}

            {speechChunks.length > 0 && (
              <div style={{ marginTop: 15 }}>
                <input
                  type="text"
                  placeholder="Search spoken words..."
                  value={speechSearchTerm}
                  onChange={(e) => setSpeechSearchTerm(e.target.value)}
                  style={{
                    width: "100%", padding: "8px", borderRadius: "6px",
                    background: "#374151", color: "white", border: "1px solid #4b5563"
                  }}
                />
                <div style={{ marginTop: 10, maxHeight: "300px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
                  {speechChunks
                    .filter(c => (c.text || "").toLowerCase().includes(speechSearchTerm.toLowerCase()))
                    .map((chunk, idx) => (
                      <div
                        key={idx}
                        style={{
                          background: "#1f2937", padding: "10px", borderRadius: "6px",
                          cursor: "pointer", border: "1px solid transparent"
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = "#60a5fa"}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}
                        onClick={() => handleSpeechSeek(chunk.timestamp)}
                      >
                        <div style={{ color: "#60a5fa", fontSize: 12, marginBottom: 4 }}>
                          {formatTime(chunk.timestamp[0])} - {formatTime(chunk.timestamp[1])}
                        </div>
                        <div style={{ color: "#e5e7eb", fontSize: 14 }}>
                          {chunk.text}
                        </div>
                      </div>
                    ))}
                  {speechChunks.filter(c => (c.text || "").toLowerCase().includes(speechSearchTerm.toLowerCase())).length === 0 && (
                    <div style={{ color: "#9ca3af", fontStyle: "italic", fontSize: 13 }}>No matches found.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "Copilot" && (
          <div className="copilot-card">
            <div className="card-title">🤖 Offline Copilot</div>
            <div className="card-desc">Ask questions locally. No data leaves your machine. <br /><i>Note: Offline AI runs purely on your CPU and can take 15-30 seconds to type a response.</i></div>

            <div style={{ display: 'flex', flexDirection: 'column', height: '350px', marginTop: 10 }}>
              <div style={{ flex: 1, overflowY: 'auto', background: '#1f2937', borderRadius: '6px', padding: '10px', marginBottom: '10px', border: '1px solid #374151' }}>
                {copilotMessages.map((msg, idx) => (
                  <div key={idx} style={{ marginBottom: 10, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: msg.role === 'user' ? '#3b82f6' : '#374151',
                      color: '#fff',
                      maxWidth: '90%',
                      wordWrap: 'break-word',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {msg.content}
                    </span>
                  </div>
                ))}
                {copilotLoading && (
                  <div style={{ textAlign: 'left', color: '#9ca3af', fontSize: '13px', fontStyle: 'italic', marginTop: 10 }}>
                    Copilot is thinking... (may take ~5 minutes if first run)
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  type="text"
                  value={copilotInput}
                  onChange={e => setCopilotInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCopilotSend()}
                  placeholder="Ask a question..."
                  style={{ flex: 1, padding: '8px', borderRadius: '6px', background: '#374151', color: 'white', border: '1px solid #4b5563' }}
                />
                <button className="extract-btn" onClick={handleCopilotSend} disabled={copilotLoading}>
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default Sidebar;

function formatTime(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
