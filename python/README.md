## Offline long-video transcription (Python worker)

This app uses a **Python background worker** for offline transcription of **10–30 minute videos** (chunked, fault-tolerant, resumable).

### Install (once)

From `uni_project_media_player/` run:

```bash
python -m pip install -r python/requirements.txt
```

### Notes

- **GPU vs CPU**: the worker auto-detects CUDA via `torch.cuda.is_available()`.
  - If CUDA is available it uses `device=cuda` + `float16`.
  - Otherwise it uses `device=cpu` + `int8`.
- **Chunks** are written under the job folder in Electron `userData`:
  - `job.json` (metadata + control flags)
  - `segments.json` (saved after each chunk; used for resume)
  - `final_transcript.txt` (written at the end)

