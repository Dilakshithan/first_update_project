import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  extractAudio: (path) => ipcRenderer.invoke('extract-audio', path),
  transcribeVideoOnline: (params) => ipcRenderer.invoke('transcription/transcribeOnline', params),
  getOpenAiKeyStatus: () => ipcRenderer.invoke('transcription/getOpenAiKeyStatus'),
  testOpenAiKey: (params) => ipcRenderer.invoke('transcription/testOpenAiKey', params),
  saveOpenAiKeyToDotEnv: (params) => ipcRenderer.invoke('transcription/saveOpenAiKeyToDotEnv', params),
  chatCopilot: (messages) => ipcRenderer.invoke('chat-copilot', messages),
  extractCodeOnline: (base64Image) => ipcRenderer.invoke('extract-code-online', base64Image),
  mergeCodeOnline: (framesList) => ipcRenderer.invoke('merge-code-online', framesList),
  // Long-video offline transcription (job-based)
  createOfflineTranscriptionJob: (params) => ipcRenderer.invoke('offline-transcription/createJob', params),
  startOfflineTranscription: (jobId) => ipcRenderer.invoke('offline-transcription/start', jobId),
  pauseOfflineTranscription: (jobId) => ipcRenderer.invoke('offline-transcription/pause', jobId),
  resumeOfflineTranscription: (jobId) => ipcRenderer.invoke('offline-transcription/resume', jobId),
  cancelOfflineTranscription: (jobId) => ipcRenderer.invoke('offline-transcription/cancel', jobId),
  getOfflineTranscriptionJob: (jobId) => ipcRenderer.invoke('offline-transcription/getJob', jobId),
  getOfflineTranscriptionSegments: (jobId) => ipcRenderer.invoke('offline-transcription/getSegments', jobId),
  onOfflineTranscriptionProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('offline-transcription/progress', handler);
    return () => ipcRenderer.removeListener('offline-transcription/progress', handler);
  },
  getFilePath: (file) => {
    if (webUtils && webUtils.getPathForFile) {
      return webUtils.getPathForFile(file);
    }
    return file.path;
  }
});
