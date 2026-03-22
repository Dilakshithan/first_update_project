import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import "./VideoPlayer.css";
import RoiSelector from "./RoiSelector";

const VideoPlayer = forwardRef(function VideoPlayer({ roi, onRoiChange }, ref) {
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);

  const [videoSrc, setVideoSrc] = useState(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);

  // ✅ open file dialog (used by Header)
  const openFileDialog = () => fileInputRef.current?.click();

  const onSelectVideo = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // cleanup old URL
    if (videoSrc) URL.revokeObjectURL(videoSrc);

    const url = URL.createObjectURL(file);
    setVideoSrc(url);

    // Reset UI states
    setCurrent(0);
    setDuration(0);
    setIsPlaying(false);
  };

  // ✅ keep video element synced with state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (!videoSrc) {
      v.removeAttribute("src");
      v.load();
      return;
    }

    // Important: let React bind src (below) — just load it here
    v.load();
  }, [videoSrc]);

  // ✅ video event listeners
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onLoaded = () => setDuration(v.duration || 0);
    const onTime = () => setCurrent(v.currentTime || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);

    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);

    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, []);

  // ✅ controls
  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;

    try {
      if (v.paused) await v.play();
      else v.pause();
    } catch (err) {
      // autoplay restrictions / decode errors
      console.error("Play failed:", err);
    }
  };

  const stop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setCurrent(0);
    setIsPlaying(false);
  };

  const onSeek = (e) => {
    const v = videoRef.current;
    if (!v) return;
    const t = Number(e.target.value);
    v.currentTime = t;
    setCurrent(t);
  };

  const onVolume = (e) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Number(e.target.value);
    v.volume = vol;
    setVolume(vol);
  };

  // ✅ expose APIs to parent/Sidebar
  useImperativeHandle(ref, () => ({
    openFileDialog,

    getVideoFrame: (roiNorm) => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return null;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;

      const r =
        roiNorm && roiNorm.w > 0 && roiNorm.h > 0
          ? roiNorm
          : { x: 0, y: 0, w: 1, h: 1 };

      const sx = Math.floor(r.x * vw);
      const sy = Math.floor(r.y * vh);
      const sw = Math.max(1, Math.floor(r.w * vw));
      const sh = Math.max(1, Math.floor(r.h * vh));

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

      return canvas;
    },

    seekTo: (seconds) => {
      const v = videoRef.current;
      if (!v) return;
      const t = Number(seconds);
      if (Number.isFinite(t)) v.currentTime = Math.max(0, t);
    },

    getCurrentTime: () => {
      const v = videoRef.current;
      return v ? v.currentTime : 0;
    },
  }));

  return (
    <div className="video-player-container">
      {/* hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={onSelectVideo}
        style={{ display: "none" }}
      />

      <div className="video-player">
        {/* ✅ Video element (React-controlled src to avoid “double frame” bugs) */}
        <video
          ref={videoRef}
          className="video-element"
          src={videoSrc || undefined}
        />

        {/* ROI overlay only when a video is loaded */}
        {videoSrc && <RoiSelector enabled={true} onChange={onRoiChange} />}

        {!videoSrc && (
          <div className="empty-state">
            <div className="icon">🎬</div>
            <div className="title">No video selected</div>
            <div className="subtitle">Use File → Open File (or button below)</div>
            <button className="select-button" onClick={openFileDialog}>
              Select Video
            </button>
          </div>
        )}
      </div>

      <div className="controls-bar">
        <button className="control-btn" onClick={togglePlay} disabled={!videoSrc}>
          {isPlaying ? "⏸" : "▶️"}
        </button>

        <button className="control-btn" onClick={stop} disabled={!videoSrc}>
          ⏹
        </button>

        <div className="time">{formatTime(current)}</div>

        <input
          className="timeline"
          type="range"
          min={0}
          max={duration || 0}
          step="0.01"
          value={current}
          onChange={onSeek}
          disabled={!videoSrc}
        />

        <div className="time">{formatTime(duration)}</div>

        <input
          className="volume-slider"
          type="range"
          min={0}
          max={1}
          step="0.01"
          value={volume}
          onChange={onVolume}
          disabled={!videoSrc}
        />
      </div>
    </div>
  );
});

export default VideoPlayer;

function formatTime(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
