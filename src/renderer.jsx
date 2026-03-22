import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import Header from "./components/Header";
import VideoPlayer from "./components/VideoPlayer";
import Sidebar from "./components/Sidebar";
import "./index.css";

const APP = () => {
  const videoPlayerRef = useRef(null);
  const [roi, setRoi] = useState(null);

  const openFile = () => {
    videoPlayerRef.current?.openFileDialog?.();
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Header openFile={openFile} />

      <div style={{ flex: 1, display: "flex", gap: "24px", padding: "24px" }}>
        <VideoPlayer ref={videoPlayerRef} roi={roi} onRoiChange={setRoi} />
        <Sidebar videoPlayerRef={videoPlayerRef} roi={roi} />
      </div>
    </div>
  );
};

createRoot(document.getElementById("root")).render(<APP />);
