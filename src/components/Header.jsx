import React, { useState,useRef,useEffect } from "react";
import "./Header.css";

export default function Header({ openFile, extractionMode, setExtractionMode }) {
  const [activeWindow, setActiveWindow] = useState(null);
  const [windowPos, setWindowPos] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);
  useEffect(() => {
  function handleOutsideClick(e) {
    if (menuRef.current && !menuRef.current.contains(e.target)) {
      setActiveWindow(null);
    }
  }

  document.addEventListener("mousedown", handleOutsideClick);
  document.addEventListener("touchstart", handleOutsideClick);

  return () => {
    document.removeEventListener("mousedown", handleOutsideClick);
    document.removeEventListener("touchstart", handleOutsideClick);
  };
}, []);


  const openWindow = (name, event) => {
    const rect = event.target.getBoundingClientRect();

    setWindowPos({
      top: rect.bottom + 6,   // small gap under menu
      left: rect.left
    });

    setActiveWindow(activeWindow === name ? null : name);
  };

  return (
    <>
      <header className="header">
        <div className="logo">MyPlayer</div>

        <nav className="nav">
    <div
      className={`menu-item ${activeWindow === "file" ? "active" : ""}`}
      onClick={(e) => openWindow("file", e)}
    >
      File
    </div>

    <div
      className={`menu-item ${activeWindow === "view" ? "active" : ""}`}
      onClick={(e) => openWindow("view", e)}
    >
      View
    </div>

    <div
      className={`menu-item ${activeWindow === "tools" ? "active" : ""}`}
      onClick={(e) => openWindow("tools", e)}
    >
      Tools
    </div>

    <div
      className={`menu-item ${activeWindow === "help" ? "active" : ""}`}
      onClick={(e) => openWindow("help", e)}
    >
      Help
    </div>
</nav>

        <div style={{ marginLeft: "auto", marginRight: "20px", display: "flex", gap: "10px", alignItems: "center", color: "white", fontSize: "14px" }}>
          <span style={{ fontWeight: 500, opacity: 0.9 }}>Code Mode:</span>
          <select 
            value={extractionMode} 
            onChange={e => setExtractionMode && setExtractionMode(e.target.value)}
            style={{ padding: "4px 8px", background: "#374151", color: "white", border: "1px solid #4b5563", borderRadius: "4px", outline: "none", cursor: "pointer" }}
          >
            <option value="offline">Offline</option>
            <option value="online">Online</option>
          </select>
        </div>

      </header>

      {activeWindow && (
        <div
          ref={menuRef}
          className="menu-window"
          style={{
            top: windowPos.top,
            left: windowPos.left
          }}
        >
          {activeWindow === "file" && (
            <>
              
              <div
              className="window-item"
              onClick={() => {
                openFile(); // triggers hidden file input
                setActiveWindow(null); // optional: closes menu
              }}
            >
              Open File
            </div>

              <div className="window-item">Open Folder</div>
              <div className="window-item">Quit</div>
            </>
          )}

          {activeWindow === "view" && (
            <>
             
              <div className="window-item">Fullscreen</div>
              <div className="window-item">Mini Player</div>
            </>
          )}

          {activeWindow === "tools" && (
            <>
              
              <div className="window-item">Preferences</div>
              <div className="window-item">Audio Settings</div>
            </>
          )}

          {activeWindow === "help" && (
            <>
             
              <div className="window-item">Documentation</div>
              <div className="window-item">About</div>
            </>
          )}
        </div>
      )}
    </>
  );
}
