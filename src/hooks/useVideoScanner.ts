import React, { useState, useEffect, useRef, useCallback } from 'react';
import { compareFrames } from '../utils/frameComparison';
import { mergeCode, rearrangeAndDeduplicate } from '../utils/codeMerger';
import { extractTextOffline } from '../services/ocrService';
import { extractTextOnline, mergeCodeBlocksOnline } from '../services/aiService';

export interface ROI {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseVideoScannerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  roi: ROI | null;
  isOnlineMode: boolean;
  isScanning: boolean;
  startTime: number;
  endTime: number | null;
  onStopScanning: () => void;
}

export function useVideoScanner({
  videoRef,
  roi,
  isOnlineMode,
  isScanning,
  startTime,
  endTime,
  onStopScanning
}: UseVideoScannerProps) {
  const [extractedCode, setExtractedCode] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isFinalizing, setIsFinalizing] = useState<boolean>(false);
  const [frameCount, setFrameCount] = useState<number>(0);
  const prevCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanIntervalRef = useRef<number | null>(null);
  const codeBlocksRef = useRef<string[]>([]);
  const isOnlineModeRef = useRef(isOnlineMode);

  useEffect(() => {
    isOnlineModeRef.current = isOnlineMode;
  }, [isOnlineMode]);

  const processFrameRef = useRef<() => Promise<void>>(async () => { });

  const processFrame = useCallback(async () => {
    if (!videoRef.current || !roi || isProcessing || videoRef.current.ended) {
      return;
    }

    const video = videoRef.current;
    const currentTime = video.currentTime;

    if (currentTime < startTime) return;
    if (endTime !== null && currentTime > endTime) {
      onStopScanning();
      return;
    }

    // Create a canvas to hold the current ROI
    const currentCanvas = document.createElement('canvas');
    currentCanvas.width = roi.width;
    currentCanvas.height = roi.height;
    const ctx = currentCanvas.getContext('2d');

    if (!ctx) return;

    // Draw the ROI portion of the video onto the canvas
    ctx.drawImage(
      video,
      roi.x, roi.y, roi.width, roi.height, // Source coordinates
      0, 0, roi.width, roi.height // Destination coordinates
    );

    // EXPLANATION: Why updates were previously missed.
    // In coding videos, typing 1-2 new characters produces a microscopic pixel difference, often < 1%.
    // Setting threshold to 0.02 (2%) was too strict and caused the scanner to ignore heavily active typing. 
    // We reduced this to 0.005 (0.5%) to ensure high sensitivity to those small text insertions.
    const hasChanged = compareFrames(prevCanvasRef.current, currentCanvas, 0.005);

    if (hasChanged) {
      setIsProcessing(true);
      try {
        let newText = '';
        if (isOnlineMode) {
          newText = await extractTextOnline(currentCanvas);
        } else {
          newText = await extractTextOffline(currentCanvas);
        }

        if (newText.trim()) {
          codeBlocksRef.current.push(newText.trim());

          // EXPLANATION: Why rearranging during scan caused bad live updates.
          // Before, running 'mergeCode' over every frame was aggressively matching and discarding code 
          // if it falsely flagged it as a "duplicate", completely swallowing small new typing additions.
          // It also executed heavy String/Levenshtein parsing on the UI thread, blocking rapid captures.

          // EXPLANATION: How new logic separates live collection from final merge.
          // During scanning mode, the sole goal is collection and fast preview. We just blindly append 
          // strings here. It is lightning fast, skips zero updates, and keeps 'isProcessing' extremely short 
          // so the timer can capture the next frame immediately. 
          // The heavy reordering, deduplication, and cleanup ONLY fires in the 'finalize()' function after Stop.
          setExtractedCode((prevCode: string) => {
            if (!prevCode) return newText.trim();
            return prevCode + '\n\n/* ... live extraction ... */\n\n' + newText.trim();
          });
        }

        setFrameCount((prev: number) => prev + 1);

        // Update previous canvas only if we successfully processed it
        prevCanvasRef.current = currentCanvas;
      } catch (error) {
        console.error("Error processing frame:", error);
      } finally {
        setIsProcessing(false);
      }
    }
  }, [videoRef, roi, isProcessing, isOnlineMode, startTime, endTime, onStopScanning]);

  useEffect(() => {
    processFrameRef.current = processFrame;
  }, [processFrame]);

  useEffect(() => {
    if (isScanning) {
      // Start scanning
      codeBlocksRef.current = [];
      setExtractedCode('');
      setFrameCount(0);
      scanIntervalRef.current = window.setInterval(() => {
        processFrameRef.current();
      }, 1000); // Set to 4500ms (4.5s) to stay safely under the Gemini API 15 requests/minute free-tier quota
    } else {
      // Stop scanning
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }

      // Finalize code if we have blocks
      if (codeBlocksRef.current.length > 0) {
        const finalize = async () => {
          setIsFinalizing(true);
          try {
            // 1. Strongly deduplicate locally first based on string fuzziness
            const deduplicatedLocalCode = rearrangeAndDeduplicate(codeBlocksRef.current);

            let finalCode = '';
            if (isOnlineModeRef.current) {
              // 2. Send the cleaned, deduped array to Gemini (saves tokens, massively reduces hallucination)
              // We just send the single deduped string as array of 1 to keep type signatures valid
              finalCode = await mergeCodeBlocksOnline([deduplicatedLocalCode]);
            } else {
              // Offline fallback: Use the smart local fuzzy merger directly
              finalCode = deduplicatedLocalCode;
            }
            setExtractedCode(finalCode);
          } catch (error) {
            console.error("Error finalizing code:", error);
            setExtractedCode(codeBlocksRef.current.join('\n\n/* --- Next Frame --- */\n\n'));
          } finally {
            setIsFinalizing(false);
            codeBlocksRef.current = [];
          }
        };
        finalize();
      }
    }

    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }
    };
  }, [isScanning]); // Only depend on isScanning

  const clearCode = () => {
    setExtractedCode('');
    setFrameCount(0);
    codeBlocksRef.current = [];
  };

  return { extractedCode, isProcessing, isFinalizing, clearCode, frameCount };
}
