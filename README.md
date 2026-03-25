# React + Electron Media Player (with Offline AI)

An advanced media player built with React, Vite, and Electron, featuring offline capabilities such as Region of Interest (ROI) Code Extraction using OCR, Offline Audio-to-Text Transcription via Whisper, and a Local AI Copilot Chat.

## Prerequisites

Before running this project on a new PC, make sure you have the following installed:

1. **[Node.js](https://nodejs.org/)** (v18 or higher recommended) - Required to run the Electron and React environment.
2. **[Python 3](https://www.python.org/downloads/)** (v3.8 - v3.11 recommended) - Required for the external offline long-form audio transcription worker. Ensure Python is added to your system `PATH` during installation.

## Installation

1. **Extract or clone the project.**
   Open a terminal/command prompt and navigate into the root directory of the project.

2. **Install Node.js Dependencies**
   Run the following command to download all standard project dependencies (Electron, React, Vite, Tesseract.js, Fluent-FFMPEG, etc.):
   ```bash
   npm install
   ```

3. **Install Python Dependencies**
   The application uses a Python worker for the "long offline" transcription mode feature. Install the required Python packages by running:
   ```bash
   pip install faster-whisper torch
   ```
   *(Note: `torch` will run on CPU by default. If your machine has a dedicated NVIDIA GPU, you can [install PyTorch with CUDA support](https://pytorch.org/get-started/locally/) for significantly faster long-video transcription).*

4. **Download Local AI Models (For 100% Offline Support)**
   This project uses `@xenova/transformers` to run machine learning models purely locally (for the smart AI Copilot Chat and the quick audio transcription). You must download the models to your machine before running the app. Run the included script:
   ```bash
   node download-models.mjs
   ```
   *This process might take a few minutes. It will create a `models/` directory in the root folder containing the downloaded model state.*

5. **Set Up Gemini API Key (For Online Code Extraction)**
   The project uses the Gemini API for highly accurate, multi-frame online code extraction. You must provide a generic API key for the application to interact with Google's servers.
   - Get a free API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
   - Create a file named `.env` in the root directory of the project.
   - Add the following line to the file:
     ```env
     GEMINI_API_KEY=your_actual_api_key_here
     ```

## Running the Application

To start the application in development mode with HMR (Hot Module Replacement):

```bash
npm start
```

This will launch the Electron application containing the media player interface.

## Packaging the App

If you want to build a standalone executable or installer package (e.g. `.exe` on Windows) for distribution:

```bash
npm run make
```

Check the generated `out/` folder for your distributable files once the build process completes.

## Features

- **Standard Video Playback:** Play standard media files locally.
- **ROI Code Extraction:** Draw a bounding box over code within a video (such as a screencast tutorial), and click "Start Window Scan". The app uses `Tesseract.js` + structural tracking to extract programming code directly into your clipboard.
- **Offline Audio to Text:**
  - Short videos (under 10 mins): Runs quickly within the local node process using `@xenova/whisper-tiny.en`.
  - Long videos (10 mins+): Dispatches tasks to a background `faster-whisper` Python worker with chunking and resume support.
- **Local AI Copilot:** A completely private, integrated text generator model (`Qwen1.5-0.5B-Chat`) that answers queries through the "Copilot" sidebar panel.
