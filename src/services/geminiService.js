export async function runGeminiExtraction(videoPlayerRef, roi, lastBase64LengthRef) {
  const canvas = videoPlayerRef.current.getVideoFrame(roi);
  if (!canvas) {
    console.error("[Gemini] Failed to capture video frame.");
    throw new Error("Failed to capture video frame from player.");
  }
  
  const base64Full = canvas.toDataURL("image/jpeg");
  if (!base64Full || base64Full === "data:,") {
    throw new Error("ROI image capture failed (blank image produced).");
  }

  const b64Data = base64Full.split(',')[1];
  
  if (lastBase64LengthRef && lastBase64LengthRef.current === b64Data.length) {
    console.log(`[Gemini] Skipping identical frame. Base64 length: ${b64Data.length}`);
    return { skipped: true };
  }
  if (lastBase64LengthRef) lastBase64LengthRef.current = b64Data.length;
  
  const approximateBlobSize = Math.round((b64Data.length * 3) / 4);
  
  console.log("[online] mode:", "online");
  console.log("[online] roi:", roi);
  console.log("[online] captured image size:", approximateBlobSize);
  console.log("[online] base64 length:", b64Data.length);
  console.log("[online] sending Gemini request...");
  
  const rawData = await window.api.extractCodeOnline(b64Data);
  
  if (!rawData || !rawData.trim()) {
    throw new Error("No code detected in selected ROI");
  }
  
  let cleaned = rawData.trim();

  if (cleaned.startsWith("\`\`\`")) {
    const lines = cleaned.split("\\n");
    if (lines.length > 1) {
      lines.shift();
      if (lines[lines.length - 1].trim().startsWith("\`\`\`")) {
        lines.pop();
      }
      cleaned = lines.join("\\n");
    }
  }
  
  return cleaned;
}
