import { useRef, useState, useEffect } from "react";
import "./RoiSelector.css";

export default function RoiSelector({ enabled = true, isScanning = false, currentRoi, onChange }) {
  const overlayRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState(null);
  const [box, setBox] = useState(null);

  useEffect(() => {
    if (!currentRoi && !dragging) {
      setBox(null);
    }
  }, [currentRoi, dragging]);

  const getNormPoint = (clientX, clientY) => {
    const rect = overlayRef.current.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: clamp01(x), y: clamp01(y) };
  };

  const onMouseDown = (e) => {
    if (!enabled) return;
    const p = getNormPoint(e.clientX, e.clientY);
    setStart(p);
    setDragging(true);
    setBox(null);
  };

  const onMouseMove = (e) => {
    if (!enabled || !dragging || !start) return;
    const p = getNormPoint(e.clientX, e.clientY);

    const x1 = Math.min(start.x, p.x);
    const y1 = Math.min(start.y, p.y);
    const x2 = Math.max(start.x, p.x);
    const y2 = Math.max(start.y, p.y);

    setBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  };

  const commit = () => {
    if (!enabled) return;
    setDragging(false);
    setStart(null);

    if (box && box.w > 0.02 && box.h > 0.02) {
      onChange?.(box);
    }
  };

  return (
    <div
      ref={overlayRef}
      className={`roi-overlay ${enabled ? "" : "disabled"}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={commit}
      onMouseLeave={commit}
    >
      {box && (
        <div
          className="roi-rect"
          style={{
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
          }}
        />
      )}
      <div className="roi-hint" style={{ display: isScanning ? "none" : undefined }}>Drag to select ROI (code area)</div>
    </div>
  );
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
