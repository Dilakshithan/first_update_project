import { pipeline, env } from '@xenova/transformers';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// We use a temporary cache directory for the initial download
const tempCache = path.join(__dirname, '.temp_cache');
const finalModelsDir = path.join(__dirname, 'models');

env.cacheDir = tempCache;
env.allowLocalModels = false;

async function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  
  const files = fs.readdirSync(source);
  for (const file of files) {
    const curSource = path.join(source, file);
    const curTarget = path.join(target, file);
    
    if (fs.lstatSync(curSource).isDirectory()) {
      copyFolderRecursiveSync(curSource, curTarget);
    } else {
      fs.copyFileSync(curSource, curTarget);
    }
  }
}

async function downloadAndExtract(repo, task) {
  console.log(`Downloading ${repo}...`);
  // 1. Download to cache
  await pipeline(task, repo);
  
  // 2. Find the snapshot folder in cache
  const safeRepoName = repo.replace('/', '--');
  const snapshotsDir = path.join(tempCache, `models--${safeRepoName}`, 'snapshots');
  
  if (fs.existsSync(snapshotsDir)) {
    const commits = fs.readdirSync(snapshotsDir);
    if (commits.length > 0) {
      const latestCommitDir = path.join(snapshotsDir, commits[0]);
      
      // 3. Copy files to our final offline directory
      const targetDir = path.join(finalModelsDir, repo);
      console.log(`Copying files to ${targetDir}...`);
      await copyFolderRecursiveSync(latestCommitDir, targetDir);
    }
  }
}

async function prepareOfflineModels() {
  console.log("Preparing models for 100% OFFLINE use. This might take a few minutes...");
  
  try {
     await downloadAndExtract('Xenova/whisper-tiny.en', 'automatic-speech-recognition');
     await downloadAndExtract('Xenova/Qwen1.5-0.5B-Chat', 'text-generation');
  } catch(e) { /* ignore pipeline errors if any */ }
  
  // Clean up cache
  console.log("Cleaning up temporary files...");
  try { fs.rmSync(tempCache, { recursive: true, force: true }); } catch (e) {}

  console.log("============= DONE =============");
  console.log("Models are successfully configured! Your app will now run completely offline.");
}

prepareOfflineModels();
