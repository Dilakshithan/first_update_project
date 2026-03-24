Empty One - Video Player App
============================

A desktop media player built with Electron + React + Vite, including:
- Video playback controls
- OCR/code extraction
- Speech transcription search (short and long offline modes)

------------------------------------------------------------
1. Prerequisites (for another computer)
------------------------------------------------------------

Install these first:

1) Node.js 18+ (recommended 20+)
   - Download: https://nodejs.org/
   - Verify:
     node -v
     npm -v

2) Python 3.10+ (required for long-video offline transcription worker)
   - Verify:
     python --version

3) Internet access for first-time model download (if model files are not bundled)

Note:
- ffmpeg and ffprobe binaries are provided by npm packages (`ffmpeg-static`, `ffprobe-static`),
  so users do not need to install system ffmpeg manually for normal use.

------------------------------------------------------------
2. Clone and install
------------------------------------------------------------

1) Clone the repo and open project:
   git clone <your-repo-link>
   cd uni_project_media_player

2) Install Node dependencies:
   npm install

3) Install Python dependencies (for long offline jobs 10-30 min):
   python -m pip install -r python/requirements.txt

------------------------------------------------------------
3. Run the app
------------------------------------------------------------

Start development app:

   npm start

------------------------------------------------------------
4. Offline transcription modes
------------------------------------------------------------

- 0-10 min: normal offline mode (fast path in Electron main process)
- 10-30 min: long-video offline mode (chunked background Python worker)
- 30+ min: online mode recommended (slow offline can be enabled optionally)

Long-video mode features:
- Chunked processing (default 30s chunks)
- Progress reporting
- Pause / Resume / Cancel
- Resume from last completed chunk
- Intermediate results saved after each chunk

------------------------------------------------------------
5. Main dependencies
------------------------------------------------------------

Automatically installed by `npm install`:
- electron
- react, react-dom
- @xenova/transformers
- fluent-ffmpeg
- ffmpeg-static
- ffprobe-static
- tesseract.js

Python packages (installed separately):
- faster-whisper
- torch

------------------------------------------------------------
6. Build / package
------------------------------------------------------------

Package app:
   npm run package

Create installers:
   npm run make

------------------------------------------------------------
7. Troubleshooting
------------------------------------------------------------

If long offline transcription fails:
- Check Python is installed: `python --version`
- Install worker deps again:
  `python -m pip install -r python/requirements.txt`
- Restart app after dependency install.

If npm dependencies are broken:
  delete node_modules and package-lock.json
  npm install
  npm start

------------------------------------------------------------
8. Contact
------------------------------------------------------------

Author: Dilakshithan
Email: dilakpuhal@gmail.com

