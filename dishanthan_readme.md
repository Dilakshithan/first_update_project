# Dishanthan AI Media Player

Welcome to the AI Media Player project! This Electron application offers offline/online speech-to-text transcription, AI Copilot, and intelligent OCR code extraction directly from video frames.

### 🌟 Dependencies Needed to Run This Project on a New Computer

If someone downloads this project to a fresh computer without any prior setup, they **must** install and configure the following dependencies:

#### 1. Node.js (v18 or higher)
- **Why**: Required to run the Electron app and bundle the frontend Vite framework.
- **How**: Download from `nodejs.org`.
- **Action**: Open a terminal inside the project folder and run:
  ```bash
  npm install
  ```
  *(This automatically downloads major JavaScript libraries like `@xenova/transformers`, `fluent-ffmpeg`, `@google/genai`, etc.)*

#### 2. Python (v3.9 or higher)
- **Why**: Needed for the "Long Video" offline speech-to-text algorithm. The project uses a robust background Python worker to transcribe audio chunks efficiently to prevent memory crashes.
- **How**: Download from `python.org` (ensure "Add Python to PATH" is checked during installation).
- **Action**: Once Python is installed, run the following in the terminal to grab the Python dependencies:
  ```bash
  python -m pip install faster-whisper
  ```

#### 3. Offline AI Models (Local Weights)
- **Why**: The app's Offline Chat Copilot and Offline Transcription modes rely on ONNX machine-learning models that run locally. Since AI neural networks are massive files, they aren't uploaded to code repositories and must be placed manually.
- **Action**: 
  1. Create a `models` folder inside the root project directory.
  2. Inside `models`, create a `Xenova` folder.
  3. Download the specific **ONNX weights** from HuggingFace and place them like so:
      - `models/Xenova/Qwen1.5-0.5B-Chat/` (Must contain `tokenizer.json` and ONNX files for Copilot)
      - `models/Xenova/whisper-tiny.en/` (Must contain ONNX files for Offline Speech)

#### 4. Environment Variables (API Keys for Online Mode)
- **Why**: To offer a blazing fast alternative to offline processing, this app features an "Online Mode" that leverages cloud AI APIs (Groq and Google Gemini).
- **Action**: Create a `.env` file inside the main project folder containing your developer API keys:
  ```env
  # Used for ultra-fast Cloud Audio-to-Text transcription via Groq Cloud
  OPENAI_API_KEY=gsk_your_groq_api_key_here

  # Used for extracting Code/Text from video frames via Gemini Vision
  VITE_GOOGLE_API_KEY=your_gemini_api_key_here
  ```

### 🚀 How to Start the App
Once you have installed the Node packages, the Python packages, placed the models, and created your `.env` file, running the app is simple:
```bash
npm start
```
