import React, { useEffect, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import { runGeminiExtraction } from "../services/geminiService";

export default function CodeExtractionPanel({ videoPlayerRef, roi, isSelectingRoi, onRequestRoiSelect, onCancelRoiSelect, onScanStateChange, extractionMode }) {
  const [isScanning, setIsScanning] = useState(false);
  const [status, setStatus] = useState("Select ROI to begin");
  const [finalOutput, setFinalOutput] = useState("");
  const [copied, setCopied] = useState(false);

  // Internal scanning controls (minimum capture timings)
  const minOcrCooldownMs = extractionMode === "online" ? 1000 : 1200;
  const minCheckMs = extractionMode === "online" ? 1000 : 250;     // how often we CHECK changes (cheap)

  // Refs for loop state
  const stopRef = useRef(true);
  const checkTimerRef = useRef(null);

  const lastSigRef = useRef(null);            // last frame signature
  const lastOcrAtRef = useRef(0);             // last OCR timestamp (real time ms)
  const lastAcceptedTextRef = useRef("");     // last accepted OCR snapshot text
  
  const geminiBlocksRef = useRef([]);
  const lastBase64LengthRef = useRef(0);
  const lineMapRef = useRef(new Map());       // Map<lineNumber, { text, qualityScore, sourceFrame }>
  const frameCounterRef = useRef(0);
  const sessionModeRef = useRef(null);        // null | "numbered" | "unnumbered"
  const hadAnyNumberedRef = useRef(false);
  const unnumberedLinesRef = useRef([]);      // ordered accepted lines (top-to-bottom)
  const lastUnnumberedBlockSigRef = useRef("");

  // ---------- helpers ----------
  const getVideoTime = () => {
    if (!videoPlayerRef?.current) return 0;
    if (typeof videoPlayerRef.current.getCurrentTime === "function") {
      return videoPlayerRef.current.getCurrentTime();
    }
    return 0;
  };

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
    return diff >= (extractionMode === "online" ? 5 : 6);
  }

  // ---------- OCR step ----------
  const runOnlineOnce = async (tNow) => {
    if (!videoPlayerRef?.current || !roi) return;
    setStatus(`Sending to Gemini @ ${formatTime(tNow)}...`);
    try {
      const codeOrSkip = await runGeminiExtraction(videoPlayerRef, roi, lastBase64LengthRef);
      if (codeOrSkip?.skipped) {
        setStatus(`Skipping identical frame @ ${formatTime(tNow)}`);
        return;
      }
      const code = codeOrSkip;
      if (!stopRef.current) {
        geminiBlocksRef.current.push(code);
        
        const incomingLines = code.split("\n");
        const merged = mergeUnnumberedLines(unnumberedLinesRef.current, incomingLines);
        unnumberedLinesRef.current = merged;
        const out = merged.join("\n");
        setFinalOutput(out);
        setStatus(`Code extracted @ ${formatTime(tNow)}`);
      }
    } catch (err) {
      console.error(err);
      if (!stopRef.current) {
        let msg = err.message || "";
        if (msg === "No code detected in selected ROI") {
          setStatus(msg);
        } else {
          if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) {
            msg = "Quota Exceeded (Daily limits hit - wait or check API Key restrictions)";
          } else if (msg.length > 50) {
            msg = msg.substring(0, 50) + "...";
          }
          setStatus(`API Error: ${msg}`);
        }
      }
    }
  };

  const runOcrOnce = async (videoTimeSec) => {
    if (!videoPlayerRef?.current || !roi) return;

    const canvas = videoPlayerRef.current.getVideoFrame(roi);
    if (!canvas) return;

    setStatus(`OCR running @ ${formatTime(getVideoTime())}...`);
    const { data } = await Tesseract.recognize(canvas, "eng");
    const raw = data?.text || "";

    const normalizedFrameText = normalizeFrameText(raw);
    if (!normalizedFrameText) return;

    const prev = lastAcceptedTextRef.current;
    const sim = similarityRatio(prev, normalizedFrameText);

    // If it's almost the same, ignore
    if (sim >= 0.97) {
      setStatus("OCR result ~same (ignored)");
      return;
    }

    const frameId = ++frameCounterRef.current;

    // Parse numbered lines strictly; ignore everything else.
    const numberedCandidates = parseFrameNumberedLines(raw);
    const trusted = filterTrustedNumberedLines(numberedCandidates, lineMapRef.current);
    const shouldUseNumbered = detectNumberedMode(numberedCandidates, trusted);

    if (shouldUseNumbered) {
      hadAnyNumberedRef.current = true;
      sessionModeRef.current = "numbered";
    } else if (!sessionModeRef.current) {
      // After a couple frames with no reliable numbering, lock into fallback.
      if (frameId >= 3) sessionModeRef.current = "unnumbered";
    }

    for (const entry of trusted) {
      const incoming = {
        text: entry.codeText,
        qualityScore: scoreOcrCodeQuality(entry.codeText),
        sourceFrame: frameId,
      };
      const existing = lineMapRef.current.get(entry.lineNumber);
      lineMapRef.current.set(entry.lineNumber, mergeLineEntry(existing, incoming));
    }

    lastAcceptedTextRef.current = normalizedFrameText;
    if (sessionModeRef.current === "numbered") {
      setStatus(
        trusted.length > 0
          ? `Snapshot captured (${trusted.length} numbered lines)`
          : "Snapshot ignored (no trusted numbered lines)"
      );
      return;
    }

    // --- fallback unnumbered mode ---
    const incomingLines = extractUnnumberedLines(raw);
    const blockSig = blockSignature(incomingLines);
    const blockSim = blockSimilarityScore(lastUnnumberedBlockSigRef.current, blockSig);
    if (blockSig && blockSim >= 0.92) {
      setStatus("Snapshot ignored (same screen content)");
      return;
    }

    const merged = mergeUnnumberedLines(unnumberedLinesRef.current, incomingLines);
    unnumberedLinesRef.current = merged;
    lastUnnumberedBlockSigRef.current = blockSig;
    setStatus(
      incomingLines.length > 0
        ? `Snapshot captured (${incomingLines.length} lines)`
        : "Snapshot ignored (no readable lines)"
    );

  };

  const resetSession = () => {
    stopRef.current = false;
    setFinalOutput("");
    lastAcceptedTextRef.current = "";
    lineMapRef.current = new Map();
    frameCounterRef.current = 0;
    sessionModeRef.current = null;
    hadAnyNumberedRef.current = false;
    unnumberedLinesRef.current = [];
    lastUnnumberedBlockSigRef.current = "";
    lastSigRef.current = null;
    // DO NOT reset lastOcrAtRef.current = 0; to enforce global rate limits across session boundary clicks
    geminiBlocksRef.current = [];
    lastBase64LengthRef.current = 0;
  };

  const startExtraction = () => {
    if (!roi) {
      setStatus("Select ROI first");
      return;
    }
    if (!videoPlayerRef?.current) {
      setStatus("Video player not ready");
      return;
    }
    if (isScanning) return;

    resetSession();
    setIsScanning(true);
    onScanStateChange?.(true);
    setStatus(`Scanning... @ ${formatTime(getVideoTime())}`);

    const tick = async () => {
      if (stopRef.current) return;

      const tNow = getVideoTime();
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
            if (extractionMode === "online") {
              await runOnlineOnce(tNow);
            } else {
              await runOcrOnce(tNow);
            }
          } catch (e) {
            console.error(e);
            setStatus(extractionMode === "online" ? "Gemini error (check console)" : "OCR error (check console)");
          }
        } else if (!changed) {
          setStatus(`No change @ ${formatTime(tNow)} (skipping)`);
        } else {
          setStatus(`Changed but cooldown @ ${formatTime(tNow)} (waiting)`);
        }
      }

      checkTimerRef.current = setTimeout(tick, minCheckMs);
    };

    tick();
  };

  const stopExtraction = async () => {
    if (!isScanning) return;
    stopRef.current = true;
    setIsScanning(false);
    onScanStateChange?.(false);
    setStatus("Scan stopped - finalizing");
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    checkTimerRef.current = null;
    
    // Stop the ROI selection immediately so the user can interact while merging completes
    onCancelRoiSelect?.();

    if (extractionMode === "online") {
      const blocks = geminiBlocksRef.current;
      if (blocks.length === 0) {
        setFinalOutput("No code detected in selected ROI");
        setStatus("No code detected in selected ROI");
      } else if (blocks.length === 1) {
        setFinalOutput(blocks[0]);
        setStatus("Code extracted");
      } else {
        setStatus(`Merging ${blocks.length} frames with Gemini AI...`);
        try {
          const merged = await window.api.mergeCodeOnline(blocks);
          setFinalOutput(merged || "No code detected");
          setStatus("Frames successfully merged!");
        } catch (err) {
          console.error("Merge error:", err);
          setFinalOutput(blocks.join("\n\n"));
          let msg = err.message || "";
          if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) {
            msg = "Quota Exceeded (Daily limit hit - wait or check API Key restrictions)";
          } else if (msg.length > 50) {
            msg = msg.substring(0, 50) + "...";
          }
          setStatus(`Merge failed: ${msg}`);
        }
      }
      return;
    }

    const numberedOut = finalizeOrderedCode(lineMapRef.current);
    const unnumberedOut = unnumberedLinesRef.current.join("\n").trim();

    const out =
      (sessionModeRef.current === "numbered" && numberedOut) ||
      (numberedOut && hadAnyNumberedRef.current) ||
      unnumberedOut;

    setFinalOutput(out || "No code extracted");
    setStatus(out ? "Scan stopped" : "No code extracted");
  };

  const toggleScan = () => {
    if (!roi) {
      setStatus("Select ROI to begin");
      return;
    }
    if (isScanning) stopExtraction();
    else startExtraction();
  };

  const onClickRoiSelect = () => {
    if (isScanning) {
      setStatus("Stop scan before reselecting ROI");
      return;
    }
    onRequestRoiSelect?.();
    setStatus("ROI selection active");
  };

  useEffect(() => {
    if (isScanning) return;
    if (isSelectingRoi) {
      setStatus("ROI selection active");
      return;
    }
    if (roi) setStatus("ROI selected");
    else setStatus("Select ROI to begin");
  }, [roi, isSelectingRoi, isScanning]);

  useEffect(() => {
    return () => {
      stopRef.current = true;
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
      checkTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="code-card" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="card-title">✨ OCR & Code Extraction</div>

      <div className="card-desc">
        Select ROI first, then start/stop scan from here.
        <br />
        Video playback controls are independent from OCR scan.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="extract-btn"
          onClick={onClickRoiSelect}
        >
          ROI Select
        </button>

        <button
          className={`extract-btn ${isScanning ? "stop-mode" : ""}`}
          onClick={toggleScan}
          disabled={!roi}
        >
          {isScanning ? "Stop" : "Start Window Scan"}
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
          Select ROI on the video first.
        </div>
      )}

      <div style={{ marginTop: 10, color: "#9ca3af", fontSize: 12 }}>
        Status: {status}
      </div>

      <div className="output-area" style={{ 
        whiteSpace: "pre-wrap", 
        fontSize: "15px", 
        flex: "1 1 0px", 
        minHeight: 0,
        fontFamily: "'Fira Code', 'Courier New', monospace",
        border: "1px solid #4ade80",
        padding: "10px",
        borderRadius: "6px",
        overflowY: "auto"
      }}>
        {finalOutput || "Final code will appear here after the scan ends..."}
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

function normalizeFrameText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function parseFrameNumberedLines(rawText) {
  const lines = (rawText || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    const parsed = splitLineNumberAndCode(line);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

function detectNumberedMode(numberedCandidates, trusted) {
  if (Array.isArray(trusted) && trusted.length >= 2) return true;

  const nums = (Array.isArray(numberedCandidates) ? numberedCandidates : [])
    .map((x) => x?.lineNumber)
    .filter((n) => Number.isInteger(n));
  const unique = new Set(nums);
  return unique.size >= 4;
}

function splitLineNumberAndCode(rawLine) {
  const input = (rawLine || "").trim();
  if (!input) return null;

  const m = input.match(/^([~`'".,:;|!\[\](){}<>+\-_/\\A-Za-z0-9]{1,6})\s+(.*)$/);
  if (!m) return null;

  const rawPrefix = m[1];
  const codeText = cleanCodeText(m[2]);
  if (!codeText) return null;

  const lineNumber = parseLineNumber(rawPrefix);
  if (!lineNumber) return null;

  return { lineNumber, codeText, rawPrefix, rawLine: input };
}

function parseLineNumber(rawPrefix) {
  const normalized = normalizeLineNumberText(rawPrefix);
  if (!normalized) return null;
  if (!/^\d{1,4}$/.test(normalized)) return null;

  const num = Number(normalized);
  if (!Number.isInteger(num) || num <= 0 || num > 5000) return null;
  return num;
}

function normalizeLineNumberText(rawPrefix) {
  const src = (rawPrefix || "").trim();
  if (!src) return "";

  let mapped = "";
  for (const ch of src) {
    if (/\d/.test(ch)) {
      mapped += ch;
      continue;
    }
    // OCR confusions
    if (/[Oo]/.test(ch)) mapped += "0";
    else if (/[Il|]/.test(ch)) mapped += "1";
    else if (/[Ss]/.test(ch)) mapped += "5";
    else if (/[Bb]/.test(ch)) mapped += "8";
    else if (/[Zz]/.test(ch)) mapped += "2";
  }

  return mapped.replace(/^0+(\d)/, "$1");
}

function detectSequentialNumberBlock(numberedLines) {
  if (!Array.isArray(numberedLines) || numberedLines.length === 0) return new Set();
  const nums = [...new Set(numberedLines.map((x) => x.lineNumber))].sort((a, b) => a - b);
  const trusted = new Set();

  let run = [nums[0]];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) run.push(nums[i]);
    else {
      if (run.length >= 2) run.forEach((n) => trusted.add(n));
      run = [nums[i]];
    }
  }
  if (run.length >= 2) run.forEach((n) => trusted.add(n));
  return trusted;
}

function filterTrustedNumberedLines(numberedLines, existingLineMap = new Map()) {
  const seqTrusted = detectSequentialNumberBlock(numberedLines);
  const trustedByContext = new Set();

  if (seqTrusted.size === 0) {
    for (const line of numberedLines) {
      if (!line?.lineNumber) continue;
      if (existingLineMap.has(line.lineNumber - 1) || existingLineMap.has(line.lineNumber + 1)) {
        trustedByContext.add(line.lineNumber);
      }
    }
  }

  return numberedLines.filter((x) => {
    if (!x || !x.codeText) return false;
    if (seqTrusted.size > 0 && seqTrusted.has(x.lineNumber)) return true;
    if (trustedByContext.has(x.lineNumber)) return true;
    return false;
  });
}

function cleanCodeText(text) {
  const t = (text || "").replace(/[ \t]+/g, " ").trim();
  if (!t) return "";
  if (/^[|:.,;`'"]+$/.test(t)) return "";
  return t;
}

function scoreOcrCodeQuality(text) {
  const t = (text || "").trim();
  if (!t) return -999;

  let score = 0;
  score += Math.min(80, t.length);
  if (/[A-Za-z]/.test(t)) score += 20;
  if (/[{}()[\];.=<>+\-/*]/.test(t)) score += 15;
  if (/\b(class|public|private|static|void|if|for|while|return|new)\b/.test(t)) score += 25;

  const noiseHits = (t.match(/[^A-Za-z0-9_{}()[\];,.=<>+\-/*"'`:\s]/g) || []).length;
  score -= noiseHits * 6;
  if (/\s{3,}/.test(t)) score -= 8;
  return score;
}

function mergeLineEntry(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const oldNorm = normalizeLine(existing.text);
  const newNorm = normalizeLine(incoming.text);
  if (oldNorm === newNorm) {
    if (incoming.qualityScore > existing.qualityScore) return incoming;
    return existing;
  }

  if (incoming.qualityScore > existing.qualityScore + 6) return incoming;
  if (existing.qualityScore > incoming.qualityScore + 6) return existing;

  const oldAlphaNum = (existing.text.match(/[A-Za-z0-9]/g) || []).length;
  const newAlphaNum = (incoming.text.match(/[A-Za-z0-9]/g) || []).length;
  return newAlphaNum >= oldAlphaNum ? incoming : existing;
}

function finalizeOrderedCode(lineMap) {
  if (!(lineMap instanceof Map) || lineMap.size === 0) return "";

  const ordered = [...lineMap.entries()]
    .filter(([num, entry]) => Number.isInteger(num) && num > 0 && entry?.text)
    .sort((a, b) => a[0] - b[0]);

  const out = [];
  for (const [, entry] of ordered) {
    const clean = cleanCodeText(entry.text);
    if (!clean) continue;
    out.push(clean);
  }

  return out.join("\n").trim();
}

function extractUnnumberedLines(rawText) {
  return (rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(cleanOcrLine)
    .filter((l) => l && !isUnnumberedNoiseLine(l));
}

function cleanOcrLine(line) {
  return (line || "")
    .replace(/[ \t]+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function isUnnumberedNoiseLine(line) {
  const t = (line || "").trim();
  if (!t) return true;
  if (/^[|:.,;`'"]+$/.test(t)) return true;
  if (/^\d{1,4}$/.test(t)) return true;
  return false;
}

function normalizeOcrLine(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .replace(/[^\w{}()[\];,.=<>+\-/*"'`:\s]/g, "")
    .trim();
}

function isNearDuplicate(a, b) {
  const na = normalizeOcrLine(a);
  const nb = normalizeOcrLine(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  let same = 0;
  for (let i = 0; i < minLen; i++) if (na[i] === nb[i]) same++;
  const ratio = same / maxLen;
  return ratio >= 0.92;
}

function blockSignature(lines) {
  const norm = (Array.isArray(lines) ? lines : [])
    .slice(0, 80)
    .map(normalizeOcrLine)
    .filter(Boolean)
    .join("\n");
  return norm;
}

function blockSimilarityScore(sigA, sigB) {
  const a = (sigA || "").trim();
  const b = (sigB || "").trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < minLen; i++) if (a[i] === b[i]) same++;
  return same / maxLen;
}

function mergeUnnumberedLines(existingLines, incomingLines) {
  const existing = Array.isArray(existingLines) ? [...existingLines] : [];
  const incoming = Array.isArray(incomingLines) ? incomingLines : [];
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];

  const tail = existing.slice(Math.max(0, existing.length - 40));
  const tailSig = blockSignature(tail);
  const incSig = blockSignature(incoming);
  if (blockSimilarityScore(tailSig, incSig) >= 0.92) return existing;

  for (const line of incoming) {
    if (!line) continue;
    const last = existing.length ? existing[existing.length - 1] : "";
    if (isNearDuplicate(last, line)) continue;

    let dup = false;
    for (let i = Math.max(0, existing.length - 200); i < existing.length; i++) {
      if (isNearDuplicate(existing[i], line)) {
        dup = true;
        break;
      }
    }
    if (!dup) existing.push(line);
  }
  return existing;
}
