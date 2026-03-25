// src/components/Sidebar.jsx
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import CodeExtractionPanel from "./CodeExtractionPanel";
import "./Sidebar.css";

const Sidebar = forwardRef(function Sidebar({ videoPlayerRef, roi, isSelectingRoi, onRequestRoiSelect, onCancelRoiSelect, onScanStateChange, extractionMode, onSubtitleChange }, ref) {
  const [activeTab, setActiveTab] = useState("Code");

  // --- Speech / Audio Extraction ---
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechChunks, setSpeechChunks] = useState([]);
  const [speechSearchTerm, setSpeechSearchTerm] = useState("");
  const [speechError, setSpeechError] = useState(null);
  const [speechMode, setSpeechMode] = useState("idle"); // idle|normal|long|online
  const [speechJobId, setSpeechJobId] = useState(null);
  const [speechJobStatus, setSpeechJobStatus] = useState("Idle");
  const [speechProgress, setSpeechProgress] = useState({
    totalChunks: 0,
    completedChunks: 0,
    currentChunk: 0,
    percent: 0,
    statusText: "",
  });
  // State unified with extractionMode global prop.

  // --- Copilot Chat ---
  const [copilotMessages, setCopilotMessages] = useState([{ role: 'assistant', content: 'Hi! I am your offline AI Copilot. Ask me anything!' }]);
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotLoading, setCopilotLoading] = useState(false);

  // --- Subtitle Generator (online mode only, fully isolated) ---
  const [subtitleSettings, setSubtitleSettings] = useState({
    enabled: false,
    targetLanguage: "ta",
    showOverlay: false,
    isGenerating: false,
    hasGenerated: false,
  });
  const SUBTITLE_LANGUAGES = [
    { label: "Tamil",    code: "ta" },
    { label: "English",  code: "en" },
    { label: "Sinhala",  code: "si" },
    { label: "Hindi",    code: "hi" },
    { label: "Arabic",   code: "ar" },
    { label: "French",   code: "fr" },
    { label: "Japanese", code: "ja" },
  ];
  // Isolated subtitle output — never overwrites speechChunks
  const [translatedSubtitleSegments, setTranslatedSubtitleSegments] = useState([]);
  const [subtitleError, setSubtitleError] = useState(null);

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
  }), [speechLoading, speechChunks, speechError, extractionMode]);

  // Auto-trigger online transcription when mode switches to online and video is ready
  useEffect(() => {
    if (extractionMode !== "online") return;
    if (speechLoading || speechChunks.length > 0 || speechError) return;
    const videoPath = videoPlayerRef?.current?.getVideoPath?.();
    if (!videoPath) return;
    console.log("[Sidebar] Mode switched to online with loaded video — auto-starting shared transcription.");
    handleExtractAudio();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractionMode]);

  // Notify parent whenever subtitle overlay state changes (read by VideoPlayer)
  useEffect(() => {
    if (onSubtitleChange) {
      onSubtitleChange(
        subtitleSettings.showOverlay && subtitleSettings.hasGenerated,
        translatedSubtitleSegments
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleSettings.showOverlay, subtitleSettings.hasGenerated, translatedSubtitleSegments]);

  useEffect(() => {
    if (!window.api?.onOfflineTranscriptionProgress) return;

    let lastUpdateTime = 0;
    let pendingPayload = null;
    let throttleTimer = null;

    const processPayload = (payload) => {
      const t = payload.type;
      const activeJob = payload.jobId;

      const mergeSegmentsIntoChunks = (jobId) => {
        if (!jobId || !window.api?.getOfflineTranscriptionSegments) return;
        window.api
          .getOfflineTranscriptionSegments(jobId)
          .then((segments) => {
            const mapped = (segments || []).map((s) => ({
              text: s.text || "",
              timestamp: [Number(s.start || 0), Number(s.end || 0)],
              chunkIndex: s.chunkIndex,
            }));
            mapped.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
            setSpeechChunks(mapped);
          })
          .catch(() => {});
      };

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
        mergeSegmentsIntoChunks(activeJob);
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
      } else if (t === "error") {
        setSpeechJobStatus("Error");
        setSpeechProgress((p) => ({ ...p, statusText: "Error" }));
        setSpeechError(payload.message || "Unknown worker error");
        setSpeechLoading(false);
      } else if (t === "worker_exit") {
        setSpeechLoading((prevLoading) => {
          // If it was still loading but the worker died, it crashed or was killed
          if (prevLoading) {
             setSpeechJobStatus(payload.code === 0 ? "Completed" : "Worker Stopped");
             setSpeechProgress((p) => ({ ...p, statusText: `Worker stopped (code ${payload.code})` }));
             if (payload.code !== 0 && !speechError) setSpeechError(`Transcription worker missing or crashed (code: ${payload.code}). Make sure Python and 'faster-whisper' are correctly installed!`);
          }
          return false;
        });
      } else if (t === "job_completed") {
        setSpeechJobStatus("Completed");
        setSpeechProgress((p) => ({ ...p, statusText: "Completed" }));
        setSpeechLoading(false);
        mergeSegmentsIntoChunks(activeJob);
      }
    };

    const unsubscribe = window.api.onOfflineTranscriptionProgress((payload) => {
      if (!payload) return;
      if (speechJobId && payload.jobId !== speechJobId) return;

      const now = Date.now();
      const isUrgent = [
        "job_started",
        "job_completed",
        "job_paused",
        "job_cancelled",
        "chunk_failed",
        "chunk_completed",
      ].includes(payload.type);

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

  const runOfflineTranscription = async (videoPath) => {
    // Ask main process which offline mode to use (normal vs long / Python worker)
    const jobInfo = await window.api.createOfflineTranscriptionJob({
      videoPath,
      chunkSec: 45,
      modelPreset: "fast",
      enableVad: true,
    });

    if (jobInfo?.mode === "normal") {
      setSpeechMode("normal");
      setSpeechJobStatus("Running (normal offline)");
      const chunks = await window.api.extractAudio(videoPath);
      setSpeechChunks(chunks || []);
      setSpeechJobStatus("Completed");
      return false;
    }
    if (jobInfo?.mode === "long") {
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
      return true;
    }
    throw new Error("Unknown transcription mode");
  };

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
    let longJobStarted = false;
    try {
      if (extractionMode === "online") {
        setSpeechMode("online");
        setSpeechJobStatus("Online requested — trying cloud first...");
        try {
          const chunks = await window.api.transcribeVideoOnline({
            videoPath: path,
            apiKey: undefined,
          });
          setSpeechChunks(chunks || []);
          setSpeechJobStatus("Completed (online)");
          return;
        } catch (onlineErr) {
          const msg = String(onlineErr?.message || onlineErr || "").toLowerCase();
          const shouldFallback =
            msg.includes("api key missing") ||
            msg.includes("401") ||
            msg.includes("403");
          if (!shouldFallback) throw onlineErr;
          setSpeechError(null);
          setSpeechJobStatus("Online unavailable. Auto-switching to offline...");
          longJobStarted = await runOfflineTranscription(path);
          return;
        }
      }

      longJobStarted = await runOfflineTranscription(path);
    } catch (err) {
      console.error(err);
      setSpeechError(err.message || "Failed to extract audio");
    } finally {
      if (!longJobStarted) setSpeechLoading(false);
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
        {["Playlist", "Code", "Speech", "Copilot", ...(extractionMode === "online" ? ["Subtitle"] : []), "Info"].map((tab) => (
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
                Offline Mode: Uses local Whisper (no data sent). Online Mode: Uses fast cloud transcription via Groq AI.
              </i>
            </div>

            {extractionMode === "online" && (
              <div style={{ marginTop: 10 }}>
                <div style={{ marginTop: 6, color: "#9ca3af", fontSize: 11 }}>
                  Online mode automatically falls back to offline if the API key or quota fails.
                </div>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <button className="extract-btn" onClick={handleExtractAudio} disabled={speechLoading}>
                {speechLoading
                  ? "Processing..."
                  : extractionMode === "online"
                    ? "▶ Extract Audio to Text (Online)"
                    : "▶ Extract Audio to Text (Offline)"}
              </button>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
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

        {activeTab === "Subtitle" && extractionMode === "online" && (
          <div className="speech-card">
            <div className="card-title">🎬 Subtitle Generator</div>
            <div className="card-desc">
              Translate video speech into subtitles in your chosen language.
              <br />
              <i>Online mode only. Uses shared transcript — does not re-run speech-to-text.</i>
            </div>

            {/* Enable Subtitle Translation toggle */}
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <button
                className="extract-btn"
                onClick={() =>
                  setSubtitleSettings((prev) => ({ ...prev, enabled: !prev.enabled }))
                }
                style={{
                  background: subtitleSettings.enabled ? "#16a34a" : "#374151",
                  border: `1px solid ${subtitleSettings.enabled ? "#4ade80" : "#6b7280"}`,
                  minWidth: 160,
                }}
              >
                {subtitleSettings.enabled ? "✅ Translation ON" : "⬜ Enable Translation"}
              </button>
            </div>

            {/* Target Language selector */}
            <div style={{ marginTop: 14 }}>
              <label style={{ color: "#9ca3af", fontSize: 12, display: "block", marginBottom: 6 }}>
                Target Language
              </label>
              <select
                value={subtitleSettings.targetLanguage}
                disabled={!subtitleSettings.enabled}
                onChange={(e) =>
                  setSubtitleSettings((prev) => ({ ...prev, targetLanguage: e.target.value }))
                }
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "6px",
                  background: subtitleSettings.enabled ? "#374151" : "#1f2937",
                  color: subtitleSettings.enabled ? "white" : "#6b7280",
                  border: "1px solid #4b5563",
                  cursor: subtitleSettings.enabled ? "pointer" : "not-allowed",
                  fontSize: 13,
                }}
              >
                {SUBTITLE_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Status indicator */}
            <div style={{ marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
              Status:{" "}
              {subtitleSettings.isGenerating
                ? <span style={{ color: "#f59e0b" }}>Generating subtitles...</span>
                : subtitleSettings.hasGenerated
                  ? <span style={{ color: "#4ade80" }}>✅ Subtitles ready</span>
                  : subtitleSettings.enabled
                    ? <span style={{ color: "#4ade80" }}>Ready — translating to {SUBTITLE_LANGUAGES.find(l => l.code === subtitleSettings.targetLanguage)?.label}</span>
                    : <span>Translation disabled</span>
              }
            </div>

            {/* Generate Subtitles button — only when enabled */}
            {subtitleSettings.enabled && (
              <div style={{ marginTop: 14 }}>
                <button
                  className="extract-btn"
                  disabled={subtitleSettings.isGenerating}
                  onClick={async () => {
                    setSubtitleError(null);

                    // If transcript is still loading, wait — do not show error
                    if (speechLoading) {
                      setSubtitleError("Transcript is still being prepared. Please wait a moment and try again.");
                      return;
                    }

                    // If no transcript yet, auto-trigger for the user
                    if (!speechChunks || speechChunks.length === 0) {
                      setSubtitleError("No transcript yet. Ensure a video is loaded and online Audio-to-Text has completed (Speech tab).");
                      return;
                    }

                    console.log(`[Subtitle] Translate requested. Lang: ${subtitleSettings.targetLanguage}, Segments: ${speechChunks.length}`);
                    setSubtitleSettings((prev) => ({ ...prev, isGenerating: true, hasGenerated: false }));

                    // Build read-only snapshot (speechChunks never modified)
                    const snapshot = speechChunks.map((chunk) => ({
                      text: chunk.text,
                      timestamp: chunk.timestamp,
                      translatedText: null,
                    }));

                    try {
                      // Call isolated subtitle/translate IPC (separate from code extraction)
                      const result = await window.api.translateSubtitles({
                        segments: snapshot,
                        targetLanguage: subtitleSettings.targetLanguage,
                      });
                      setTranslatedSubtitleSegments(result);
                      console.log(`[Subtitle] Translation complete. ${result.length} segments stored.`);
                      setSubtitleSettings((prev) => ({ ...prev, isGenerating: false, hasGenerated: true }));
                    } catch (err) {
                      console.error("[Subtitle] Translation error:", err);
                      const msg = err?.message || "";
                      if (msg.includes("GEMINI_API_KEY")) {
                        setSubtitleError("Gemini API key missing. Add GEMINI_API_KEY to your .env file.");
                      } else if (msg.includes("429") || msg.includes("quota")) {
                        setSubtitleError("API quota exceeded. Try again later.");
                      } else {
                        setSubtitleError(`Translation failed: ${msg.slice(0, 80)}`);
                      }
                      setSubtitleSettings((prev) => ({ ...prev, isGenerating: false, hasGenerated: false }));
                    }
                  }}
                  style={{ width: "100%", background: subtitleSettings.isGenerating ? "#374151" : "#1d4ed8" }}
                >
                  {subtitleSettings.isGenerating ? "⏳ Generating..." : "▶ Generate Subtitles"}
                </button>
                {subtitleError && (
                  <div style={{ color: "#ef4444", fontSize: 12, marginTop: 6 }}>
                    ⚠ {subtitleError}
                  </div>
                )}
              </div>
            )}

            {/* Show Subtitles on Video toggle — only when enabled and generated */}
            {subtitleSettings.enabled && (
              <div style={{ marginTop: 12 }}>
                <button
                  className="extract-btn"
                  disabled={!subtitleSettings.hasGenerated}
                  onClick={() =>
                    setSubtitleSettings((prev) => ({ ...prev, showOverlay: !prev.showOverlay }))
                  }
                  style={{
                    width: "100%",
                    background: !subtitleSettings.hasGenerated
                      ? "#1f2937"
                      : subtitleSettings.showOverlay ? "#7c3aed" : "#374151",
                    color: !subtitleSettings.hasGenerated ? "#6b7280" : "white",
                    border: `1px solid ${subtitleSettings.hasGenerated ? "#8b5cf6" : "#374151"}`,
                    cursor: !subtitleSettings.hasGenerated ? "not-allowed" : "pointer",
                  }}
                >
                  {subtitleSettings.showOverlay ? "🟣 Subtitles Visible" : "⬜ Show Subtitles on Video"}
                </button>
                {!subtitleSettings.hasGenerated && (
                  <div style={{ color: "#6b7280", fontSize: 11, marginTop: 4 }}>
                    Generate subtitles first to enable overlay.
                  </div>
                )}
              </div>
            )}
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
