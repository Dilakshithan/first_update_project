import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  extractAudio: (path) => ipcRenderer.invoke('extract-audio', path),
  chatCopilot: (messages) => ipcRenderer.invoke('chat-copilot', messages),
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
