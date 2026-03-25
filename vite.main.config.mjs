import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        '@xenova/transformers',
        'onnxruntime-node',
        'fluent-ffmpeg',
        'ffmpeg-static',
        'wavefile',
        'bufferutil',
        'utf-8-validate',
        '@google/genai'
      ]
    }
  }
});
