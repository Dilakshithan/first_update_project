import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import Header from "./components/Header";
import VideoPlayer from "./components/VideoPlayer";
import Sidebar from "./components/Sidebar";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

const APP = () => {
  const videoPlayerRef = useRef(null);
  const sidebarRef = useRef(null);
  const [roi, setRoi] = useState(null);
  const [isSelectingRoi, setIsSelectingRoi] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [extractionMode, setExtractionMode] = useState("offline");

  const openFile = () => {
    videoPlayerRef.current?.openFileDialog?.();
  };

  const onVideoPlay = () => {
    sidebarRef.current?.autoStartServices?.();
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Header openFile={openFile} extractionMode={extractionMode} setExtractionMode={setExtractionMode} />

      <div style={{ flex: 1, display: "flex", gap: "24px", padding: "24px" }}>
        <VideoPlayer 
          ref={videoPlayerRef} 
          roi={roi} 
          onRoiChange={(newRoi) => { setRoi(newRoi); setIsSelectingRoi(false); }} 
          onPlay={onVideoPlay} 
          isSelectingRoi={isSelectingRoi} 
          isScanning={isScanning}
        />
        <Sidebar 
          ref={sidebarRef} 
          videoPlayerRef={videoPlayerRef} 
          roi={roi} 
          isSelectingRoi={isSelectingRoi}
          onRequestRoiSelect={() => setIsSelectingRoi(true)}
          onCancelRoiSelect={() => { setIsSelectingRoi(false); setRoi(null); }}
          onScanStateChange={(scanning) => setIsScanning(scanning)}
          extractionMode={extractionMode}
        />
      </div>
    </div>
  );
};

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <APP />
  </ErrorBoundary>
);
