import React, { useState, useEffect, useRef, useCallback } from 'react';
import { compareFrames } from '../utils/frameComparison';
import { mergeCode } from '../utils/codeMerger';
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

  const processFrameRef = useRef<() => Promise<void>>(async () => {});

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

    // Compare with previous frame
    const hasChanged = compareFrames(prevCanvasRef.current, currentCanvas, 0.02); // 2% difference threshold

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
          setExtractedCode(prevCode => mergeCode(prevCode, newText.trim()));
        }
        
        setFrameCount(prev => prev + 1);
        
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
      }, 1000); // Fixed 1 second interval
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
            let finalCode = '';
            if (isOnlineModeRef.current) {
              finalCode = await mergeCodeBlocksOnline(codeBlocksRef.current);
            } else {
              // Offline fallback: simple merge
              finalCode = codeBlocksRef.current.reduce((acc, curr) => mergeCode(acc, curr), '');
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
