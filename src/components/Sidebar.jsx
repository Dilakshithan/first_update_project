// src/components/Sidebar.jsx
import React, { useEffect, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import "./Sidebar.css";

export default function Sidebar({ videoPlayerRef, roi }) {
  const [activeTab, setActiveTab] = useState("Code");



  // User chooses duration only (no gap)
  const [windowSec, setWindowSec] = useState(60); // default 1 minute
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [finalOutput, setFinalOutput] = useState("");
  const [copied, setCopied] = useState(false);

  // Internal scanning controls (minimum capture timings)
  const minCheckMs = 250;     // how often we CHECK changes (cheap)
  const minOcrCooldownMs = 1200; // minimum time between OCR runs (expensive)

  // Refs for loop state
  const stopRef = useRef(false);
  const checkTimerRef = useRef(null);

  const lastSigRef = useRef(null);            // last frame signature
  const lastOcrAtRef = useRef(0);             // last OCR timestamp (real time ms)
  const latestFullCodeRef = useRef("");       // last accepted full code
  const tEndRef = useRef(0);                  // end time (video timeline seconds)

  // ---------- helpers ----------
  const getVideoTime = () => {
    if (!videoPlayerRef?.current) return 0;
    if (typeof videoPlayerRef.current.getCurrentTime === "function") {
      return videoPlayerRef.current.getCurrentTime();
    }
    return 0;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Very simple cleaning; later you will replace with your intelligent filter pipeline
  const basicNormalize = (txt) =>
    (txt || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .trim();

  // Similarity check to avoid overwriting good code with tiny OCR noise
  const similarityRatio = (a, b) => {
    a = (a || "").trim();
    b = (b || "").trim();
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    // quick ratio based on common length heuristic (cheap)
    const minLen = Math.min(a.length, b.length);
    const maxLen = Math.max(a.length, b.length);
    let same = 0;
    for (let i = 0; i < minLen; i++) if (a[i] === b[i]) same++;
    return same / maxLen;
  };

  // ---------- frame signature (change detection) ----------
  // Create a tiny grayscale "signature" array from the canvas
  function computeSignature(canvas, w = 32, h = 32) {
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;

    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);
    const sig = new Uint8Array(w * h);

    // grayscale signature
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // integer grayscale approx
      sig[p] = (r * 30 + g * 59 + b * 11) / 100;
    }
    return sig;
  }

  // Compare two signatures (0 = same, bigger = more different)
  function signatureDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 1e9;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length; // average abs difference 0..255
  }

  // Decide if frame changed enough to OCR
  function isChangedEnough(prevSig, newSig) {
    if (!prevSig) return true;
    const diff = signatureDiff(prevSig, newSig);

    // threshold: tune if needed
    // ~0-2: almost same
    // ~3-8: small change
    // >8: significant change
    return diff >= 6;
  }

  // ---------- OCR step ----------
  const runOcrOnce = async () => {
    if (!videoPlayerRef?.current || !roi) return;

    const canvas = videoPlayerRef.current.getVideoFrame(roi);
    if (!canvas) return;

    // OCR
    setStatus(`OCR running @ ${formatTime(getVideoTime())}...`);
    const { data } = await Tesseract.recognize(canvas, "eng");
    const raw = data?.text || "";
    const normalized = basicNormalize(raw);

    if (!normalized) return;

    // If you later add transformers.js, it goes here:
    // const refined = await refineWithTransformers(normalized);
    // For now:
    const refined = normalized;

    const prev = latestFullCodeRef.current;
    const sim = similarityRatio(prev, refined);

    // If it's almost the same, ignore
    if (sim >= 0.97) {
      setStatus("OCR result ~same (ignored)");
      return;
    }

    // Accept as new "full code snapshot"
    // Merge this snapshot into accumulated full code (keeps correct order)
    latestFullCodeRef.current = mergeCodeOrdered(
      latestFullCodeRef.current,
      refined
    );
    setStatus("Merged snapshot into full code");

  };

  // ---------- main scan loop ----------
  const startWindowScan = async () => {
    if (running) return;
    if (!roi) {
      setStatus("Select ROI first");
      return;
    }
    if (!videoPlayerRef?.current) {
      setStatus("Video player not ready");
      return;
    }

    // reset
    stopRef.current = false;
    setRunning(true);
    setFinalOutput("");
    latestFullCodeRef.current = "";
    lastSigRef.current = null;
    lastOcrAtRef.current = 0;

    const tStart = getVideoTime();
    tEndRef.current = tStart + Number(windowSec);

    setStatus(`Scanning ${windowSec}s from ${formatTime(tStart)} to ${formatTime(tEndRef.current)}...`);

    // change-check loop
    const tick = async () => {
      if (stopRef.current) return;

      const tNow = getVideoTime();
      if (tNow >= tEndRef.current) {
        // finish
        setRunning(false);
        stopRef.current = true;
        const out = latestFullCodeRef.current;
        setFinalOutput(out || "No code detected in this window.");
        setStatus("Window scan complete");
        return;
      }

      // capture ROI frame and compute signature (cheap)
      const canvas = videoPlayerRef.current.getVideoFrame(roi);
      if (canvas) {
        const sigNow = computeSignature(canvas, 32, 32);
        const changed = isChangedEnough(lastSigRef.current, sigNow);
        lastSigRef.current = sigNow;

        const nowMs = Date.now();
        const cooldownOk = nowMs - lastOcrAtRef.current >= minOcrCooldownMs;

        if (changed && cooldownOk) {
          lastOcrAtRef.current = nowMs;
          try {
            await runOcrOnce();
          } catch (e) {
            console.error(e);
            setStatus("OCR error (check console)");
          }
        } else {
          // optional status
          if (!changed) setStatus(`No change @ ${formatTime(tNow)} (skipping)`);
          else setStatus(`Changed but cooldown @ ${formatTime(tNow)} (waiting)`);
        }
      }

      // schedule next tick
      checkTimerRef.current = setTimeout(tick, minCheckMs);
    };

    tick();
  };

  const stopScan = () => {
    stopRef.current = true;
    setRunning(false);
    setStatus("Stopped");
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    checkTimerRef.current = null;

    // Show whatever latest code we have so far
    const out = latestFullCodeRef.current;
    setFinalOutput(out || "Stopped (no code captured yet).");
  };

  useEffect(() => {
    return () => stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sidebar">
      {/* Tab headers */}
      <div className="tabs">
        {["Playlist", "Scene", "Code", "Info"].map((tab) => (
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
          <div className="code-card">
            <div className="card-title">✨ OCR & Code Extraction</div>

            <div className="card-desc">
              Select ROI on video → choose duration → Start.
              <br />
              App checks frames fast, OCR only when changed. Final full code shown at end.
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ color: "#9ca3af", fontSize: 12 }}>Duration</label>
              <select
                value={windowSec}
                onChange={(e) => setWindowSec(Number(e.target.value))}
                disabled={running}
                style={{ padding: "6px 8px", borderRadius: 6 }}
              >
                <option value={10}>10 sec</option>
                <option value={30}>30 sec</option>
                <option value={60}>1 min</option>
                <option value={120}>2 min</option>
              </select>

              <button className="extract-btn" onClick={startWindowScan} disabled={!roi || running}>
                ▶ Start Window Scan
              </button>

              <button className="extract-btn" onClick={stopScan} disabled={!running}>
                ⏹ Stop
              </button>

              <button
                className="extract-btn"
                onClick={async () => {
                  if (!finalOutput) return;
                  await navigator.clipboard.writeText(finalOutput);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                disabled={!finalOutput}
              >
                📋 {copied ? "Copied!" : "Copy"}
              </button>

            </div>

            {!roi && (
              <div style={{ marginTop: 10, color: "#fbbf24", fontSize: 12 }}>
                Select ROI on the video first (drag rectangle over code area).
              </div>
            )}

            <div style={{ marginTop: 10, color: "#9ca3af", fontSize: 12 }}>
              Status: {status}
            </div>

            <div className="output-area" style={{ whiteSpace: "pre-wrap" }}>
              {finalOutput || "Final code will appear here after the scan ends..."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function normalizeLine(line) {
  return (line || "").replace(/\s+/g, " ").trim();
}

// Ordered merge so insert-above keeps correct order
function mergeCodeOrdered(oldCode, newCode) {
  const oldLinesRaw = (oldCode || "").split("\n").filter(l => l.trim() !== "");
  const newLinesRaw = (newCode || "").split("\n").filter(l => l.trim() !== "");

  if (oldLinesRaw.length === 0) return newLinesRaw.join("\n");
  if (newLinesRaw.length === 0) return oldLinesRaw.join("\n");

  const oldNorm = oldLinesRaw.map(normalizeLine);
  const newNorm = newLinesRaw.map(normalizeLine);

  const n = oldNorm.length;
  const m = newNorm.length;

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldNorm[i - 1] === newNorm[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (oldNorm[i - 1] === newNorm[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  pairs.reverse();

  const usedOld = new Array(n).fill(false);
  for (const [oi] of pairs) usedOld[oi] = true;

  const merged = [];
  let oldCursor = 0;

  for (let newIdx = 0; newIdx < m; newIdx++) {
    const pair = pairs.find(p => p[1] === newIdx);
    if (pair) {
      const anchorOldIdx = pair[0];

      while (oldCursor < anchorOldIdx) {
        if (!usedOld[oldCursor]) merged.push(oldLinesRaw[oldCursor]);
        oldCursor++;
      }

      merged.push(newLinesRaw[newIdx]);
      oldCursor = anchorOldIdx + 1;
    } else {
      merged.push(newLinesRaw[newIdx]);
    }
  }

  while (oldCursor < n) {
    if (!usedOld[oldCursor]) merged.push(oldLinesRaw[oldCursor]);
    oldCursor++;
  }

  // dedup by normalized line
  const seen = new Set();
  const out = [];
  for (const line of merged) {
    const key = normalizeLine(line);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }

  return out.join("\n");
}

