import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, List


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json_atomic(path: str, obj: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_segments(segments_path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(segments_path):
        return []
    with open(segments_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        return data if isinstance(data, list) else []


def ffmpeg_segment_audio(ffmpeg_path: str, video_path: str, out_dir: str, chunk_sec: int) -> List[str]:
    os.makedirs(out_dir, exist_ok=True)
    out_pattern = os.path.join(out_dir, "chunk_%05d.wav")

    # Segment directly from video -> wav chunks (mono 16kHz).
    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "segment",
        "-segment_time",
        str(chunk_sec),
        "-reset_timestamps",
        "1",
        out_pattern,
    ]
    emit({"type": "stage", "stage": "chunking_started", "chunkSec": chunk_sec})
    subprocess.check_call(cmd)
    emit({"type": "stage", "stage": "chunking_completed"})

    # Return chunk files sorted
    chunks = []
    for name in sorted(os.listdir(out_dir)):
        if name.startswith("chunk_") and name.endswith(".wav"):
            chunks.append(os.path.join(out_dir, name))
    return chunks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True, help="Path to job.json")
    args = parser.parse_args()

    job_path = args.job
    job = read_json(job_path)

    video_path = job["sourceVideoPath"]
    out_dir = job["outputDir"]
    ffmpeg_path = job.get("ffmpegPath") or "ffmpeg"
    segments_path = job.get("segmentsFile") or os.path.join(out_dir, "segments.json")
    chunk_sec = int(job.get("chunkSec") or 30)
    duration_sec = float(job.get("durationSec") or 0)
    total_chunks = int(job.get("totalChunks") or 0)
    model_name = job.get("selectedModel") or "small"
    enable_vad = bool(job.get("enableVad", True))

    if not os.path.exists(video_path):
        emit({"type": "error", "message": "Video file does not exist", "videoPath": video_path})
        return 2

    # Prepare chunk folder (persistent so resume is fast)
    chunks_dir = os.path.join(out_dir, "chunks_wav")
    if not os.path.exists(chunks_dir) or len([n for n in os.listdir(chunks_dir) if n.endswith(".wav")]) == 0:
        chunk_files = ffmpeg_segment_audio(ffmpeg_path, video_path, chunks_dir, chunk_sec)
    else:
        chunk_files = [
            os.path.join(chunks_dir, n)
            for n in sorted(os.listdir(chunks_dir))
            if n.startswith("chunk_") and n.endswith(".wav")
        ]

    # If metadata totalChunks wasn't known/accurate, derive it
    if total_chunks <= 0:
        total_chunks = len(chunk_files)
        job["totalChunks"] = total_chunks
        job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json_atomic(job_path, job)

    # Load existing segments for resume
    segments = load_segments(segments_path)
    completed_by_index = {int(s.get("chunkIndex")) for s in segments if "chunkIndex" in s}

    emit(
        {
            "type": "job_started",
            "status": "running",
            "totalChunks": total_chunks,
            "completedChunks": len(completed_by_index),
            "model": model_name,
            "enableVad": enable_vad,
        }
    )

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as e:
        emit(
            {
                "type": "error",
                "message": "Missing Python dependency: faster-whisper. Install it and try again.",
                "detail": str(e),
            }
        )
        return 3

    # Device selection: CUDA if available, else CPU
    device = "cpu"
    compute_type = "int8"
    try:
        import torch  # type: ignore

        if hasattr(torch, "cuda") and torch.cuda.is_available():
            device = "cuda"
            compute_type = "float16"
    except Exception:
        pass

    emit({"type": "stage", "stage": "model_loading", "device": device, "computeType": compute_type})
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    emit({"type": "stage", "stage": "model_loaded"})

    # Transcribe chunks sequentially; persist after each chunk
    for idx, wav_path in enumerate(chunk_files):
        # Refresh job control flags
        job = read_json(job_path)
        req = job.get("requestedAction") or "run"
        if req == "cancel":
            job["status"] = "cancelled"
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            write_json_atomic(job_path, job)
            emit({"type": "job_cancelled"})
            return 0
        if req == "pause":
            job["status"] = "paused"
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            write_json_atomic(job_path, job)
            emit({"type": "job_paused"})
            return 0

        if idx in completed_by_index:
            continue

        start_sec = idx * chunk_sec
        end_sec = min((idx + 1) * chunk_sec, duration_sec if duration_sec > 0 else (idx + 1) * chunk_sec)

        emit(
            {
                "type": "chunk_started",
                "chunkIndex": idx,
                "currentChunk": idx + 1,
                "totalChunks": total_chunks,
                "start": start_sec,
                "end": end_sec,
            }
        )

        try:
            seg_iter, info = model.transcribe(
                wav_path,
                vad_filter=enable_vad,
                # keep it simple; timestamps per chunk are reconstructed by chunk offsets
            )
            text_parts = []
            for seg in seg_iter:
                if seg.text:
                    text_parts.append(seg.text.strip())
            chunk_text = " ".join([t for t in text_parts if t]).strip()

            segment_obj = {
                "chunkIndex": idx,
                "start": start_sec,
                "end": end_sec,
                "text": chunk_text,
            }

            segments.append(segment_obj)
            # Keep deterministic ordering
            segments.sort(key=lambda s: int(s.get("chunkIndex", 0)))
            write_json_atomic(segments_path, segments)

            completed_by_index.add(idx)
            job["completedChunks"] = len(completed_by_index)
            job["status"] = "running"
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            job["lastError"] = None
            write_json_atomic(job_path, job)

            emit(
                {
                    "type": "chunk_completed",
                    "chunkIndex": idx,
                    "completedChunks": len(completed_by_index),
                    "totalChunks": total_chunks,
                    "percent": round(100.0 * len(completed_by_index) / max(total_chunks, 1), 2),
                }
            )
        except Exception as e:
            job["status"] = "error"
            job["lastError"] = {"chunkIndex": idx, "message": str(e)}
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            write_json_atomic(job_path, job)
            emit({"type": "chunk_failed", "chunkIndex": idx, "message": str(e)})
            # continue to next chunk (fault tolerant)
            continue

    # Final merge
    segments = load_segments(segments_path)
    segments.sort(key=lambda s: int(s.get("chunkIndex", 0)))
    final_text = "\n".join(
        [f"[{int(s.get('start', 0))}-{int(s.get('end', 0))}] {s.get('text','')}".strip() for s in segments]
    ).strip()
    final_path = os.path.join(out_dir, "final_transcript.txt")
    with open(final_path, "w", encoding="utf-8") as f:
        f.write(final_text + "\n")

    job = read_json(job_path)
    job["status"] = "completed"
    job["completedChunks"] = len(segments)
    job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json_atomic(job_path, job)
    emit({"type": "job_completed", "finalTranscriptPath": final_path, "completedChunks": len(segments), "totalChunks": total_chunks})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

