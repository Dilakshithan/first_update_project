import { app, BrowserWindow, ipcMain } from 'electron';
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
// - 10-30 min: "long offline" (Python worker, chunked + persisted)
// - 30+ min: recommend online (but we can still allow an optional slow offline job later)
const OFFLINE_NORMAL_MAX_SEC = 10 * 60;
const OFFLINE_LONG_MAX_SEC = 30 * 60;
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

let whisperWorker = null;

function getWhisperWorker() {
  if (whisperWorker) return whisperWorker;

  const workerCode = `
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

  whisperWorker = new Worker(workerCode, { eval: true });
  return whisperWorker;
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

  console.log("Waking up Transformers.js worker thread...");
  getWhisperWorker();

  // 3. Segment strategy:
  // - Short videos: single pass (fastest)
  // - Long videos: smaller segments to avoid memory overload and long freezes
  const isLongVideo = durationSec >= 5 * 60;
  const segmentSec = isLongVideo ? 120 : Math.max(30, Math.ceil(durationSec));
  const chunkLengthSec = isLongVideo ? 20 : 30;
  const allChunks = [];

  for (let segmentStart = 0; segmentStart < Math.max(durationSec, 1); segmentStart += segmentSec) {
    const segmentDuration = Math.min(segmentSec, Math.max(durationSec - segmentStart, 0));
    const tempRaw = path.join(os.tmpdir(), `audio-raw-${Date.now()}-${Math.floor(segmentStart)}.f32`);
    console.log(`Extracting audio segment: ${segmentStart.toFixed(1)}s -> ${(segmentStart + segmentDuration).toFixed(1)}s`);

    await extractRawFloatAudio(videoPath, tempRaw, segmentStart, segmentDuration);

    console.log("Reading raw audio...");
    const buffer = await fs.promises.readFile(tempRaw);
    const sampleCount = Math.floor(buffer.length / 4);
    const float32Data = new Float32Array(buffer.buffer, buffer.byteOffset, sampleCount);

    console.log(`Transcribing segment ${Math.floor(segmentStart)}s with ${sampleCount} samples...`);
    const output = await runTranscriptionInWorker(modelsPath, float32Data, chunkLengthSec);

    const segmentChunks = (output?.chunks || []).map((chunk) => {
      const start = Number(chunk?.timestamp?.[0] || 0) + segmentStart;
      const end = Number(chunk?.timestamp?.[1] || start) + segmentStart;
      return {
        ...chunk,
        timestamp: [start, end]
      };
    });

    allChunks.push(...segmentChunks);

    try {
      fs.unlinkSync(tempRaw);
    } catch (e) {}
  }

  console.log("Transcription complete.");
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
    allowOver30Min = false,
  } = params || {};

  if (!videoPath) throw new Error('No video path provided');
  if (!fs.existsSync(videoPath)) throw new Error('Video path does not exist');
  const durationSec = await probeDurationSeconds(videoPath);

  // Friendly policy
  if (durationSec <= OFFLINE_NORMAL_MAX_SEC) {
    return { mode: 'normal', durationSec };
  }
  if (durationSec > OFFLINE_LONG_MAX_SEC && !allowOver30Min) {
    return {
      mode: 'over30',
      durationSec,
      warning: 'Video is longer than 30 minutes. Online mode is recommended. You can still force slow offline mode.',
    };
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

ipcMain.handle('offline-transcription/start', async (event, jobId) => {
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
});

ipcMain.handle('offline-transcription/pause', async (event, jobId) => {
  const { jobJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  job.requestedAction = 'pause';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobJson, job);
  return { ok: true };
});

ipcMain.handle('offline-transcription/cancel', async (event, jobId) => {
  const { jobJson } = getJobPaths(jobId);
  if (!fs.existsSync(jobJson)) throw new Error('Job not found');
  const job = readJson(jobJson);
  job.requestedAction = 'cancel';
  job.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobJson, job);
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
  return await ipcMain.handlers.get('offline-transcription/start')(event, jobId);
});
