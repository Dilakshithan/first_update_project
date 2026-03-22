Empty One - Video Player App
============================

A desktop video player built with Electron, React, and Vite.
Supports playing local video files with controls: play/pause, stop, timeline, volume, fullscreen, screenshot, and a sidebar.

------------------------------------------------------------
1. Prerequisites
------------------------------------------------------------

Before running the project, make sure you have:

1. Node.js (v18 or higher) installed
   - Download: https://nodejs.org/
   - Check installation in terminal/command prompt:
     node -v
     npm -v

2. A terminal or command-line tool to run commands.

------------------------------------------------------------
2. Project Dependencies (dont need to install it automatically install)
------------------------------------------------------------

The project dependencies are listed in package.json. They include:

Main Dependencies:
- electron 40.2.1        : Desktop app runtime
- react 19.2.4           : Frontend UI library
- react-dom 19.2.4       : React DOM renderer
- @vitejs/plugin-react 5.1.3 : React plugin for Vite
- electron-squirrel-startup 1.0.1 : Windows installer support

Dev Dependencies:
- vite 5.4.21            : Development server and bundler
- @electron-forge/cli 7.11.1 : Electron Forge CLI
- @electron-forge/maker-zip 7.11.1 : Package app as ZIP
- @electron-forge/maker-squirrel 7.11.1 : Windows installer builder
- @electron-forge/maker-deb 7.11.1     : Linux .deb package builder
- @electron-forge/maker-rpm 7.11.1     : Linux .rpm package builder
- @electron-forge/plugin-auto-unpack-natives 7.11.1 : Handles native dependencies
- @electron-forge/plugin-fuses 7.11.1 : Optimizes builds
- @electron/fuses 1.8.0   : Optimizer for Electron

All dependencies are installed automatically with 'npm install'.

------------------------------------------------------------
3. Installation / Setup
------------------------------------------------------------

1. Clone or download the project folder:
   git clone <your-repo-link>
   cd empty_one

2. Install all dependencies:
   npm install

This will download Electron, React, Vite, and all required plugins.

------------------------------------------------------------
4. Running the App
------------------------------------------------------------

Start the Electron app with:

   npm start

- Opens the Electron window with your video player.
- Click "File -> Open File" or "Select Video File" to load a video.
- Controls (play/pause, timeline, volume, fullscreen, screenshot) are always visible.

------------------------------------------------------------
5. Building / Packaging
------------------------------------------------------------

To create a packaged app:

   npm run package

- Outputs a packaged app in the 'out' folder.

For platform-specific installers:

   npm run make

- Creates .exe (Windows), .zip, .deb/.rpm (Linux) installers based on configuration.

------------------------------------------------------------
6. Features
------------------------------------------------------------

- Play / Pause / Stop controls
- Timeline slider
- Volume control
- Fullscreen toggle
- Screenshot capture
- Sidebar for additional options
- Open local video files from File menu or drag and drop

------------------------------------------------------------
7. Troubleshooting / Notes
------------------------------------------------------------

- Recommended Node.js version: v18 or higher
- Electron apps must be started with 'npm start' (cannot just open index.html)
- If dependencies break:
   rm -rf node_modules package-lock.json
   npm install
   npm start

------------------------------------------------------------
8. Contact
------------------------------------------------------------

Author: Dilakshithan
Email: dilakpuhal@gmail.com

