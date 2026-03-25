import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { GoogleGenAI } from "@google/genai";
import path from 'node:path';
import started from 'electron-squirrel-startup';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs';
import os from 'os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

let lastDotEnvPathLoaded = null;

function shouldApplyDotEnvValue(key, newVal) {
  if (newVal === undefined || newVal === null) return false;
  // Always override OPENAI_API_KEY during refresh so we pick up changes without a restart!
  if (key === 'OPENAI_API_KEY') return true;
  
  const cur = process.env[key];
  if (cur === undefined || !String(cur).trim()) return true;
  return false;
}

/** Parse `.env` into `process.env` (dotenv-like; does not replace non-empty vars except OPENAI_API_KEY when empty). */
function applyDotEnvFile(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let applied = false;
  for (let line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (key === 'OPENAI_API_KEY' && !val) continue;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (shouldApplyDotEnvValue(key, val)) {
      process.env[key] = val;
      applied = true;
    }
  }
  return applied;
}

function walkAncestorsDotEnv(tryLoad, startDir) {
  if (!startDir) return;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 16; i++) {
    tryLoad(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * Re-scan `.env` files (safe to call before each online request).
 * Checks: cwd + ancestors, Electron app path + ancestors, main bundle dir (e.g. .vite/build) + ancestors, app userData.
 */
function refreshEnvFromDotFiles() {
  lastDotEnvPathLoaded = null;
  const seen = new Set();
  const tryLoad = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    if (!fs.existsSync(p)) return;
    if (!lastDotEnvPathLoaded) lastDotEnvPathLoaded = p;
    const applied = applyDotEnvFile(p);
    if (applied) console.log('[env] Applied keys from', p);
  };

  walkAncestorsDotEnv(tryLoad, process.cwd());
  try {
    walkAncestorsDotEnv(tryLoad, app.getAppPath());
  } catch (_) {
    // app not ready in theory; ignore
  }
  // Bundled dev main lives in project/.vite/build → walk from project root too
  walkAncestorsDotEnv(tryLoad, path.join(__dirname, '..', '..'));
  walkAncestorsDotEnv(tryLoad, path.join(__dirname, '..'));

  try {
    tryLoad(path.join(app.getPath('userData'), '.env'));
  } catch (_) {}
}

const PROJECT_PACKAGE_NAME = 'empty_one';

function findProjectRootForDotEnv() {
  const startDirs = [];
  try {
    startDirs.push(process.cwd());
  } catch (_e) {}
  try {
    startDirs.push(app.getAppPath());
  } catch (_e) {}
  startDirs.push(path.join(__dirname, '..', '..'));
  startDirs.push(path.join(__dirname, '..'));

  const seenRoots = new Set();
  for (const start of startDirs) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 16; i++) {
      if (seenRoots.has(dir)) break;
      seenRoots.add(dir);
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
          if (j && j.name === PROJECT_PACKAGE_NAME) return dir;
        } catch (_e) {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const fallback = path.resolve(path.join(__dirname, '..', '..'));
  if (fs.existsSync(path.join(fallback, 'package.json'))) return fallback;
  return null;
}

function mergeOpenAiKeyIntoDotEnvFile(filePath, apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) throw new Error('API key is empty');
  let raw = '';
  if (fs.existsSync(filePath)) raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const out = [];
  let replaced = false;
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const eq = t.indexOf('=');
      if (eq > 0) {
        let k = t.slice(0, eq).trim();
        if (k.startsWith('export ')) k = k.slice(7).trim();
        if (k === 'OPENAI_API_KEY') {
          if (!replaced) {
            out.push(`OPENAI_API_KEY=${trimmed}`);
            replaced = true;
          }
          continue;
        }
      }
    }
    out.push(line);
  }
  if (!replaced) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(`OPENAI_API_KEY=${trimmed}`);
  }
  fs.writeFileSync(filePath, out.join('\n'), 'utf8');
}

function openAiKeyStorePath() {
  return path.join(app.getPath('userData'), 'openai-credential.bin');
}

function hasAnyPersistedOpenAiKeyFile() {
  const out = openAiKeyStorePath();
  return fs.existsSync(out) || fs.existsSync(`${out}.plain.txt`);
}

function persistOpenAiKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return;
  try {
    const out = openAiKeyStorePath();
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(out, safeStorage.encryptString(trimmed));
    } else {
      fs.writeFileSync(`${out}.plain.txt`, trimmed, 'utf8');
    }
    console.log('[openai] Stored API key in app data (OS encryption when available).');
  } catch (e) {
    console.warn('[openai] Could not save API key:', e?.message || e);
  }
}

function loadPersistedOpenAiKey() {
  try {
    const out = openAiKeyStorePath();
    if (fs.existsSync(out)) {
      try {
        return safeStorage.decryptString(fs.readFileSync(out)).trim();
      } catch (e) {
        console.warn('[openai] Could not decrypt credential file (try pasting key again):', e?.message || e);
      }
    }
    const plain = `${out}.plain.txt`;
    if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8').trim();
  } catch (e) {
    console.warn('[openai] Could not read saved API key:', e?.message || e);
  }
  return null;
}

if (started) {
  app.quit();
}

let mainWindow = null;
const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  refreshEnvFromDotFiles();
  createWindow();


  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

let fixedFfmpegPath = ffmpegStatic;
if (!fs.existsSync(fixedFfmpegPath)) {
  const isWin = process.platform === 'win32';
  const devPath = path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', isWin ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(devPath)) {
    fixedFfmpegPath = devPath;
  }
}
ffmpeg.setFfmpegPath(fixedFfmpegPath);

// Ensure fluent-ffmpeg can find `ffprobe` for duration checks.
// `ffmpeg-static` does not always include `ffprobe`, so we use `ffprobe-static`.
try {
  const candidates = [];
  if (ffprobeStatic?.path) candidates.push(ffprobeStatic.path);

  // Dev fallback: project root `node_modules`
  candidates.push(
    path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  );

  // Another fallback: relative to Electron app path (may exist in some builds)
  candidates.push(
    path.join(app.getAppPath(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  );

  const found = candidates.find((p) => p && fs.existsSync(p));
  console.log('[ffprobe] resolved path:', found || candidates[0] || '(none)');
  if (found) ffmpeg.setFfprobePath(found);
} catch (e) {
  console.warn('Could not set ffprobe path:', e?.message || e);
}

let transcriber = null;
// Offline modes:
// - 0-10 min: "normal offline" (Transformers.js in main process)
// - 10+ min: "long offline" (Python worker, chunked + persisted)
const OFFLINE_NORMAL_MAX_SEC = 0; // Force all videos to use the queue so Pause/Cancel appear
const runningJobs = new Map(); // jobId -> { proc }

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function getJobsRoot() {
  const root = path.join(app.getPath('userData'), 'transcription-jobs');
  ensureDir(root);
  return root;
}

function getJobDir(jobId) {
  return path.join(getJobsRoot(), jobId);
}

function getJobPaths(jobId) {
  const dir = getJobDir(jobId);
  return {
    dir,
    jobJson: path.join(dir, 'job.json'),
    segmentsJson: path.join(dir, 'segments.json'),
    logTxt: path.join(dir, 'worker.log'),
  };
}

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (e) {
    // ignore
  }
}

function resolvePythonCommand() {
  // On Windows: "python" is most common. Users without python will get a friendly error.
  // If you want to support "py -3", we can add that later with a small wrapper.
  return { cmd: 'python', args: [] };
}

function probeDurationSeconds(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = Number(metadata?.format?.duration || 0);
      resolve(Number.isFinite(duration) ? duration : 0);
    });
  });
}

let chatWorker = null;

function getChatWorker() {
  if (chatWorker) return chatWorker;

  const workerCode = `
    const { parentPort } = require('node:worker_threads');
    
    let chatModel = null;

    async function initChat(modelsPath) {
      if (chatModel) return chatModel;

      const fs = require('node:fs');
      const path = require('node:path');
      const expectedDir = path.join(modelsPath, 'Xenova', 'Qwen1.5-0.5B-Chat');
      if (!fs.existsSync(path.join(expectedDir, 'tokenizer.json'))) {
        throw new Error(\`Offline AI Model Missing or Incorrectly Named!\\nCould not find model at: \${expectedDir}\\n\\nPlease ensure:\\n1. You downloaded the ONNX weights for "Xenova/Qwen1.5-0.5B-Chat".\\n2. You placed them inside a "Xenova" folder, so the path ends with "models/Xenova/Qwen1.5-0.5B-Chat/tokenizer.json".\`);
      }

      process.env.OMP_NUM_THREADS = '2';
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = modelsPath;
      env.backends.onnx.wasm.numThreads = 2;
      
      chatModel = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat');
      return chatModel;
    }

    parentPort.on('message', async (msg) => {
      try {
        if (msg.type === 'chat') {
          const t = await initChat(msg.modelsPath);
          const output = await t(msg.prompt, {
            max_new_tokens: 100,
            temperature: 0.3,
            do_sample: false
          });
          parentPort.postMessage({ id: msg.id, success: true, output });
        }
      } catch (err) {
        parentPort.postMessage({ id: msg.id, success: false, error: err?.message || String(err) });
      }
    });
  `;

  chatWorker = new Worker(workerCode, { eval: true });
  return chatWorker;
}

function runChatInWorker(modelsPath, prompt) {
  return new Promise((resolve, reject) => {
    const worker = getChatWorker();
    const id = Date.now() + Math.random().toString();
    
    const onMessage = (res) => {
      if (res.id === id) {
        worker.off('message', onMessage);
        worker.off('error', onError);
        if (res.success) resolve(res.output);
        else reject(new Error(res.error));
      }
    };
    const onError = (err) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    worker.postMessage({
      type: 'chat',
      id,
      modelsPath,
      prompt
    });
  });
}

const WHISPER_WORKERS = [];
const MAX_OFFLINE_WORKERS = 3;
let workerIndex = 0;
let whisperWorkerCode = null;

function getWhisperWorker() {
  if (WHISPER_WORKERS.length < MAX_OFFLINE_WORKERS) {
    if (!whisperWorkerCode) {
      whisperWorkerCode = `
    const { parentPort } = require('node:worker_threads');
    
    let transcriber = null;

    async function initTranscriber(modelsPath) {
      if (transcriber) return transcriber;

      const fs = require('node:fs');
      const path = require('node:path');
      const expectedDir = path.join(modelsPath, 'Xenova', 'whisper-tiny.en');
      if (!fs.existsSync(expectedDir)) {
        throw new Error(\`Offline Transcription Model Missing or Incorrectly Named!\\nCould not find model at: \${expectedDir}\\n\\nPlease ensure:\\n1. You downloaded the ONNX weights for "Xenova/whisper-tiny.en".\\n2. You placed them inside a "Xenova" folder, so the path ends with "models/Xenova/whisper-tiny.en/".\`);
      }

      process.env.OMP_NUM_THREADS = '2'; // prevent 100% CPU lockup on Windows
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = modelsPath;
      env.backends.onnx.wasm.numThreads = 2; // applies if onnx-web is bundled
      
      try {
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
          device: 'webgpu', dtype: 'fp16'
        });
      } catch (e) {
        // Fallback to CPU
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
      }
      return transcriber;
    }

    parentPort.on('message', async (msg) => {
      try {
        if (msg.type === 'transcribe') {
          const t = await initTranscriber(msg.modelsPath);
          const output = await t(msg.float32Data, {
            return_timestamps: true,
            chunk_length_s: msg.chunkLengthSec
          });
          parentPort.postMessage({ id: msg.id, success: true, output });
        }
      } catch (err) {
        parentPort.postMessage({ id: msg.id, success: false, error: err?.message || String(err) });
      }
    });
  `;
    }
    const worker = new Worker(whisperWorkerCode, { eval: true });
    WHISPER_WORKERS.push(worker);
    return worker;
  }
  
  const worker = WHISPER_WORKERS[workerIndex];
  workerIndex = (workerIndex + 1) % WHISPER_WORKERS.length;
  return worker;
}

function runTranscriptionInWorker(modelsPath, float32Data, chunkLengthSec) {
  return new Promise((resolve, reject) => {
    const worker = getWhisperWorker();
    const id = Date.now() + Math.random().toString();
    
    const onMessage = (res) => {
      if (res.id === id) {
        worker.off('message', onMessage);
        worker.off('error', onError);
        if (res.success) resolve(res.output);
        else reject(new Error(res.error));
      }
    };
    const onError = (err) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    // Pass the Float32Array to the worker and transfer its buffer
    worker.postMessage({
      type: 'transcribe',
      id,
      modelsPath,
      float32Data,
      chunkLengthSec
    }, [float32Data.buffer]);
  });
}

function extractRawFloatAudio(videoPath, outputPath, startSec = 0, durationSec = 0) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath)
      .outputOptions([
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'f32le',
        '-acodec', 'pcm_f32le'
      ]);

    if (startSec > 0) cmd.setStartTime(startSec);
    if (durationSec > 0) cmd.setDuration(durationSec);

    cmd.save(outputPath).on('end', resolve).on('error', reject);
  });
}

/** One ffmpeg pass: mono 16 kHz MP3 (small upload, works with bundled ffmpeg-static). */
function extractMp3AudioSegment(videoPath, outputPath, startSec = 0, durationSec = 0) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath).outputOptions([
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', '32k',
    ]);
    if (startSec > 0) cmd.setStartTime(startSec);
    if (durationSec > 0) cmd.setDuration(durationSec);
    cmd.save(outputPath).on('end', resolve).on('error', reject);
  });
}

function resolveOpenAiKey(explicitKey) {
  const fromUi = (explicitKey !== undefined && explicitKey !== null ? String(explicitKey) : '').trim();
  if (fromUi) return fromUi;
  const fromEnv = (process.env.OPENAI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const saved = loadPersistedOpenAiKey();
  return saved || null;
}

async function verifyOpenAiKeyWithApi(apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Key check failed (${res.status}): ${errText.slice(0, 400)}`);
  }
}

function mapOpenAiVerboseJsonToChunks(verboseJson, timeOffsetSec = 0) {
  const segments = Array.isArray(verboseJson?.segments) ? verboseJson.segments : [];
  if (segments.length === 0 && verboseJson?.text) {
    const dur = Number(verboseJson?.duration || 0);
    return [
      {
        text: String(verboseJson.text || '').trim(),
        timestamp: [timeOffsetSec, timeOffsetSec + (Number.isFinite(dur) ? dur : 0)],
      },
    ];
  }
  return segments.map((s) => ({
    text: String(s?.text || '').trim(),
    timestamp: [timeOffsetSec + Number(s?.start || 0), timeOffsetSec + Number(s?.end ?? s?.start ?? 0)],
  }));
}

/** Shorter segments + parallel API calls reduce wall-clock vs one huge upload (typical speech demo). */
const ONLINE_TRANSCRIBE_CHUNK_SEC = 2 * 60;
const ONLINE_TRANSCRIBE_PARALLEL = 4;

async function transcribeMp3WithOpenAI(mp3Path, apiKey) {
  const buf = await fs.promises.readFile(mp3Path);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(mp3Path));
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const whisperLang = (process.env.OPENAI_WHISPER_LANG ?? 'en').trim();
  if (whisperLang) form.append('language', whisperLang);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloud transcription failed (${res.status}): ${errText.slice(0, 600)}`);
  }

  const json = await res.json();
  return mapOpenAiVerboseJsonToChunks(json, 0);
}

ipcMain.handle('chat-copilot', async (event, messages) => {
  const isDev = !app.isPackaged;
  const modelsPath = isDev ? path.join(app.getAppPath(), 'models') : path.join(process.resourcesPath, 'models');

  let prompt = "";
  for(const msg of messages) {
     prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
  }
  prompt += `<|im_start|>assistant\n`;

  console.log("Generating AI response in worker...");
  const output = await runChatInWorker(modelsPath, prompt);
  
  let response = output[0].generated_text;
  if(response.startsWith(prompt)) {
     response = response.slice(prompt.length);
  }
  return response.replace(/<\|im_end\|>/g, '').trim();
});

ipcMain.handle('extract-code-online', async (event, base64Data) => {
  let apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.VITE_GOOGLE_API_KEY || "";
  
  try {
    const envPath = path.join(app.getAppPath(), '.env');
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, 'utf8');
      const match = text.match(/^(?:VITE_)?(?:GOOGLE|GEMINI)_API_KEY\s*=\s*(.*)$/m);
      if (match && match[1]) {
         apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (e) {}

  if (!apiKey) {
    throw new Error("Missing Google API Key.\\nPlease create a .env file in the project folder containing:\\nVITE_GOOGLE_API_KEY=your_key_here");
  }

  try {
    console.log(`[Gemini Main] Sending request to Gemini API via SDK (Base64 payload length: ${base64Data.length})`);
    const ai = new GoogleGenAI({ apiKey: apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Data
            }
          },
          {
            text: `You are an expert software engineer and OCR correction system.\n\nYour task is to extract ONLY the programming code visible in this image.\n\nSTRICT INSTRUCTIONS:\n1. Extract ONLY code. Do NOT include explanations, comments, or descriptions.\n2. Ignore all non-code UI elements such as file explorer, line numbers, icons, menus, terminal panels, and background text.\n3. Fix OCR errors intelligently:\n   - correct obvious variable names\n   - fix broken symbols such as { } ( ) ; : , .\n   - restore likely syntax\n4. Maintain correct formatting:\n   - proper indentation\n   - correct line breaks\n   - preserve logical structure\n5. If part of the code is unclear, infer only the most likely visible code.\n6. DO NOT add new logic that is not visible.\n7. DO NOT include markdown formatting.\n8. Return ONLY the cleaned code.`
          }
        ]
      },
      config: { temperature: 0.1 }
    });
    
    const extractedText = response.text || "";
    console.log("[online] SDK extracted text:", extractedText);
    return extractedText;
  } catch (err) {
    console.error("[Gemini Main] Extraction request failed:", err.message);
    throw err;
  }
});

ipcMain.handle('merge-code-online', async (event, framesList) => {
  if (!framesList || framesList.length === 0) return "";
  
  let apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.VITE_GOOGLE_API_KEY || "";
  try {
    const envPath = path.join(app.getAppPath(), '.env');
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, 'utf8');
      const match = text.match(/^(?:VITE_)?(?:GOOGLE|GEMINI)_API_KEY\s*=\s*(.*)$/m);
      if (match && match[1]) {
         apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (e) {}

  if (!apiKey) throw new Error("Missing Google API Key.");

  let prompt = `You are a senior software engineer resolving a code merge.

I extracted code from a scrolling video frame-by-frame.
Because the video scrolls, there is heavy duplication and overlap between frames.

Your task is to MERGE all frames into ONE clean, correct, complete code file.

CRITICAL RULES:
1. DO NOT concatenate blocks.
2. Detect overlapping lines between consecutive frames.
3. Merge overlapping sections seamlessly.
4. REMOVE all duplication completely.
5. If the same function, class, block, or logic appears multiple times, KEEP ONLY ONE.
6. Maintain the original top-to-bottom order of the code.
7. Fix small inconsistencies between frames, such as broken indentation or split lines.
8. Do NOT remove unique code.
9. Do NOT introduce new logic.
10. Return ONLY the final deduplicated code.
11. Do NOT include markdown.
12. Do NOT include explanations.

Here are the extracted frames in chronological order:\\n`;
  
  framesList.forEach((frameCode, i) => {
    prompt += `--- FRAME \${i+1} ---\\n\${frameCode}\\n\\n`;
  });
  
  try {
    console.log(`[Gemini Main] Sending multi-frame merge request via SDK (\${framesList.length} frames)`);
    const ai = new GoogleGenAI({ apiKey: apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: { temperature: 0.1 }
    });
    
    let mergedText = response.text || "";
    
    // Strip markdown fences just in case API disobeys rule 11
    if (mergedText.trim().startsWith("\`\`\`")) {
      const lines = mergedText.trim().split("\\n");
      if (lines.length > 1) {
        lines.shift();
        if (lines[lines.length - 1].trim().startsWith("\`\`\`")) {
          lines.pop();
        }
        mergedText = lines.join("\\n");
      }
    }
    
    console.log(`[Gemini Main] Multi-frame merge successful. Extracted text length: \${mergedText.length}`);
    return mergedText;
  } catch (err) {
    console.error("[Gemini Main] Merge request failed:", err.message);
    throw err;
  }
});

ipcMain.handle('extract-audio', async (event, videoPath) => {
  if (!videoPath) throw new Error("No video path provided");
  const durationSec = await probeDurationSeconds(videoPath);
  console.log(`Video duration: ${durationSec.toFixed(1)}s`);
  if (durationSec > OFFLINE_NORMAL_MAX_SEC) {
    throw new Error('This endpoint is for short offline transcription only (max 10 minutes). Use long-video offline mode or online mode.');
  }

  const isDev = !app.isPackaged;
  const modelsPath = isDev
    ? path.join(app.getAppPath(), 'models')
    : path.join(process.resourcesPath, 'models');

  console.log("Waking up Transformers.js worker threads...");
  getWhisperWorker();

  const segmentSec = 30; // 30s max chunks
  const windows = [];
  for (let start = 0; start < durationSec; start += segmentSec) {
    const segmentLen = Math.min(segmentSec, Math.max(durationSec - start, 0));
    if (segmentLen <= 0) break;
    windows.push({ start, segmentLen });
  }

  const allChunks = [];
  const MAX_CONCURRENT = 3;
  const chunkLengthSec = 30;

  for (let i = 0; i < windows.length; i += MAX_CONCURRENT) {
    const batch = windows.slice(i, i + MAX_CONCURRENT);
    const batchParts = await Promise.all(
      batch.map(async ({ start, segmentLen }) => {
        const tempRaw = path.join(os.tmpdir(), `audio-raw-${Date.now()}-${Math.floor(start)}.f32`);
        console.log(`Extracting audio segment: ${start.toFixed(1)}s -> ${(start + segmentLen).toFixed(1)}s`);

        await extractRawFloatAudio(videoPath, tempRaw, start, segmentLen);

        console.log("Reading raw audio...");
        const buffer = await fs.promises.readFile(tempRaw);
        const sampleCount = Math.floor(buffer.length / 4);
        const float32Data = new Float32Array(buffer.buffer, buffer.byteOffset, sampleCount);

        console.log(`Transcribing segment ${Math.floor(start)}s with ${sampleCount} samples...`);
        const output = await runTranscriptionInWorker(modelsPath, float32Data, chunkLengthSec);

        const segmentChunks = (output?.chunks || []).map((chunk) => {
          const s = Number(chunk?.timestamp?.[0] || 0) + start;
          const e = Number(chunk?.timestamp?.[1] || s) + start;
          return {
            ...chunk,
            timestamp: [s, e]
          };
        });

        try {
          fs.unlinkSync(tempRaw);
        } catch (e) {}
        
        return segmentChunks;
      })
    );

    for (const part of batchParts) {
      allChunks.push(...part);
    }
  }

  allChunks.sort((a, b) => Number(a.timestamp?.[0] || 0) - Number(b.timestamp?.[0] || 0));
  console.log("Transcription complete.");
  return allChunks;
});

/**
 * Online path: fast local audio extract (single ffmpeg encode per segment), then cloud STT.
 * Requires OPENAI_API_KEY or apiKey from the renderer. Audio leaves the device.
 */
ipcMain.handle('transcription/getOpenAiKeyStatus', () => {
  refreshEnvFromDotFiles();
  const apiKey = resolveOpenAiKey('');
  return {
    fromEnv: !!(process.env.OPENAI_API_KEY || '').trim(),
    fromSaved: hasAnyPersistedOpenAiKeyFile(),
    canResolve: !!apiKey,
    dotenvPath: lastDotEnvPathLoaded,
  };
});

ipcMain.handle('transcription/saveOpenAiKeyToDotEnv', async (event, params) => {
  const key = (params?.apiKey && String(params.apiKey).trim()) || '';
  if (!key) throw new Error('Paste your sk-… key in the field first, then save.');
  const root = findProjectRootForDotEnv();
  if (!root) {
    throw new Error(
      'Could not locate this app project folder (package.json with name "empty_one"). Open the app from the cloned repo folder.'
    );
  }
  const envPath = path.join(root, '.env');
  mergeOpenAiKeyIntoDotEnvFile(envPath, key);
  process.env.OPENAI_API_KEY = key;
  lastDotEnvPathLoaded = envPath;
  persistOpenAiKey(key);
  console.log('[env] Saved OPENAI_API_KEY to', envPath);
  return { ok: true, dotenvPath: envPath };
});

ipcMain.handle('transcription/testOpenAiKey', async (event, params) => {
  refreshEnvFromDotFiles();
  const keyFromUi = params?.apiKey;
  const pasted = (keyFromUi && String(keyFromUi).trim()) || '';
  if (pasted) persistOpenAiKey(pasted);
  const apiKey = resolveOpenAiKey(pasted || undefined);
  if (!apiKey) {
    throw new Error(
      'No API key found. Paste sk-… in the field, or put OPENAI_API_KEY=sk-… in a .env file next to package.json (no quotes), then click Check again.'
    );
  }
  await verifyOpenAiKeyWithApi(apiKey);
  return { ok: true };
});

ipcMain.handle('transcription/transcribeOnline', async (event, params) => {
  const { videoPath, apiKey: keyFromUi } = params || {};
  if (!videoPath) throw new Error('No video path provided');
  if (!fs.existsSync(videoPath)) throw new Error('Video path does not exist');

  refreshEnvFromDotFiles();

  const pasted = (keyFromUi && String(keyFromUi).trim()) || '';
  if (pasted) persistOpenAiKey(pasted);

  const apiKey = resolveOpenAiKey(pasted || undefined);
  if (!apiKey) {
    const hint = lastDotEnvPathLoaded
      ? ` .env was loaded from: ${lastDotEnvPathLoaded} — ensure it contains a non-empty OPENAI_API_KEY=gsk_… line.`
      : ' No .env file was found next to package.json (or in parent folders). Paste your key or create .env there.';
    throw new Error(
      `Groq API key missing.${hint} It should start with gsk_.`
    );
  }

  const durationSec = await probeDurationSeconds(videoPath);
  console.log(`[online-transcribe] duration ${durationSec.toFixed(1)}s`);

  const step = Math.max(20, ONLINE_TRANSCRIBE_CHUNK_SEC);
  const windows = [];
  for (let start = 0; start < Math.max(durationSec, 0.001); start += step) {
    const segmentLen = Math.min(step, Math.max(durationSec - start, 0));
    if (segmentLen <= 0) break;
    windows.push({ start, segmentLen });
  }

  const allChunks = [];
  for (let i = 0; i < windows.length; i += ONLINE_TRANSCRIBE_PARALLEL) {
    const batch = windows.slice(i, i + ONLINE_TRANSCRIBE_PARALLEL);
    const batchParts = await Promise.all(
      batch.map(async ({ start, segmentLen }) => {
        const tmpMp3 = path.join(os.tmpdir(), `stt-online-${Date.now()}-${start}-${Math.random().toString(16).slice(2)}.mp3`);
        console.log(`[online-transcribe] ffmpeg segment ${start}s -> ${(start + segmentLen).toFixed(1)}s`);
        await extractMp3AudioSegment(videoPath, tmpMp3, start, segmentLen);
        try {
          const partChunks = await transcribeMp3WithOpenAI(tmpMp3, apiKey);
          return partChunks.map((c) => ({
            ...c,
            timestamp: [Number(c.timestamp?.[0] || 0) + start, Number(c.timestamp?.[1] || 0) + start],
          }));
        } finally {
          try {
            fs.unlinkSync(tmpMp3);
          } catch {
            // ignore
          }
        }
      })
    );
    for (const part of batchParts) allChunks.push(...part);
  }

  allChunks.sort((a, b) => Number(a.timestamp?.[0] || 0) - Number(b.timestamp?.[0] || 0));

  console.log('[online-transcribe] complete, segments:', allChunks.length);
  return allChunks;
});

// -----------------------------
// Long-video OFFLINE job system
// -----------------------------

ipcMain.handle('offline-transcription/createJob', async (event, params) => {
  const {
    videoPath,
    chunkSec = 30,
    modelPreset = 'balanced', // fast|balanced|high
    enableVad = true,
  } = params || {};

  if (!videoPath) throw new Error('No video path provided');
  if (!fs.existsSync(videoPath)) throw new Error('Video path does not exist');
  const durationSec = await probeDurationSeconds(videoPath);

  // Friendly policy
  if (durationSec <= OFFLINE_NORMAL_MAX_SEC) {
    return { mode: 'normal', durationSec };
  }
  const safeChunk = Math.max(10, Math.min(60, Number(chunkSec) || 30));
  const jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const { dir, jobJson, segmentsJson } = getJobPaths(jobId);
  ensureDir(dir);

  const model =
    modelPreset === 'fast' ? 'base' :
    modelPreset === 'high' ? 'medium' :
    'small';

  const totalChunks = Math.ceil(durationSec / safeChunk);

  const job = {
    jobId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceVideoPath: videoPath,
    outputDir: dir,
    chunkSec: safeChunk,
    durationSec,
    totalChunks,
    completedChunks: 0,
    status: 'created', // created|running|paused|cancelled|completed|error
    requestedAction: 'run', // run|pause|cancel
    selectedModel: model,
    modelPreset,
    enableVad: !!enableVad,
    ffmpegPath: fixedFfmpegPath,
    segmentsFile: segmentsJson,
    segments: [], // do not fill in memory; worker writes segments.json
    lastError: null,
  };

  writeJsonAtomic(jobJson, job);
  if (!fs.existsSync(segmentsJson)) writeJsonAtomic(segmentsJson, []);

  return { mode: 'long', jobId, durationSec, totalChunks, chunkSec: safeChunk, selectedModel: model };
});

ipcMain.handle('offline-transcription/getJob', async (event, jobId) => {
  const { jobJson, segmentsJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  let completedChunks = job.completedChunks || 0;
  try {
    if (fs.existsSync(segmentsJson)) {
      const segs = readJson(segmentsJson);
      completedChunks = Array.isArray(segs) ? segs.length : completedChunks;
    }
  } catch {}
  return { ...job, completedChunks };
});

ipcMain.handle('offline-transcription/getSegments', async (event, jobId) => {
  const { segmentsJson } = getJobPaths(jobId);
  if (!fs.existsSync(segmentsJson)) return [];
  const segs = readJson(segmentsJson);
  return Array.isArray(segs) ? segs : [];
});

async function startJobInternal(jobId) {
  const paths = getJobPaths(jobId);
  if (!fs.existsSync(paths.jobJson)) throw new Error('Job not found');
  if (runningJobs.has(jobId)) return { ok: true, alreadyRunning: true };

  const job = readJson(paths.jobJson);
  job.status = 'running';
  job.requestedAction = 'run';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(paths.jobJson, job);

  const workerScript = path.join(app.getAppPath(), 'src', 'workers', 'transcribe_worker.py');
  if (!fs.existsSync(workerScript)) {
    throw new Error('Worker script missing: transcribe_worker.py');
  }

  const { cmd, args } = resolvePythonCommand();
  const proc = spawn(cmd, [...args, workerScript, '--job', paths.jobJson], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningJobs.set(jobId, { proc });

  const logStream = fs.createWriteStream(paths.logTxt, { flags: 'a' });
  proc.stdout.on('data', (buf) => {
    const text = buf.toString('utf-8');
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.type) {
          sendToRenderer('offline-transcription/progress', { jobId, ...msg });
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  });
  proc.stderr.on('data', (buf) => {
    const text = buf.toString('utf-8');
    logStream.write(text);
    sendToRenderer('offline-transcription/progress', { jobId, type: 'log', level: 'error', message: text });
  });
  proc.on('exit', (code) => {
    logStream.end();
    runningJobs.delete(jobId);
    sendToRenderer('offline-transcription/progress', { jobId, type: 'worker_exit', code });
  });

  return { ok: true };
}

ipcMain.handle('offline-transcription/start', async (event, jobId) => {
  return await startJobInternal(jobId);
});

ipcMain.handle('offline-transcription/pause', async (event, jobId) => {
  const { jobJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  job.requestedAction = 'pause';
  job.status = 'paused';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobJson, job);

  if (runningJobs.has(jobId)) {
    const { proc } = runningJobs.get(jobId);
    try { proc.kill(); } catch (e) {}
    runningJobs.delete(jobId);
    sendToRenderer('offline-transcription/progress', { jobId, type: 'job_paused' });
  }
  return { ok: true };
});

ipcMain.handle('offline-transcription/cancel', async (event, jobId) => {
  const { jobJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  job.requestedAction = 'cancel';
  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobJson, job);

  if (runningJobs.has(jobId)) {
    const { proc } = runningJobs.get(jobId);
    try { proc.kill(); } catch (e) {}
    runningJobs.delete(jobId);
    sendToRenderer('offline-transcription/progress', { jobId, type: 'job_cancelled' });
  }
  return { ok: true };
});

ipcMain.handle('offline-transcription/resume', async (event, jobId) => {
  const { jobJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  job.requestedAction = 'run';
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobJson, job);
  // resume is just start again; worker skips completed chunks
  return await startJobInternal(jobId);
});
