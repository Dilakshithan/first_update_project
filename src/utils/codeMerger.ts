/**
 * Simple line-based merging algorithm used for LIVE UI updates.
 */
export function mergeCode(oldCode: string, newCode: string): string {
  if (!oldCode) return newCode;
  if (!newCode) return oldCode;

  // For live preview, we do a very fast, slightly fuzzy merge to prevent massive overlaps
  return fuzzyMerge(oldCode, newCode, 0.1); 
}

/**
 * Robust post-processing algorithm that rearranges and heavily deduplicates 
 * all collected blocks AFTER the ROI scan stops.
 */
export function rearrangeAndDeduplicate(blocks: string[]): string {
  if (!blocks || blocks.length === 0) return '';
  if (blocks.length === 1) return blocks[0];

  // Sequentially merge all blocks with a highly forgiving fuzzy overlap
  // This stitches scrolling text together and ignores OCR typos
  let merged = blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    merged = fuzzyMerge(merged, blocks[i], 0.25); // 25% error margin for final deep clean
  }
  
  return cleanOutput(merged);
}

/**
 * Fuzzy Merge Engine: stitches two blocks of code by finding the best overlapping suffix/prefix.
 */
function fuzzyMerge(oldCode: string, newCode: string, errorTolerance: number): string {
  const oldLines = oldCode.split('\n').map(l => l.trimEnd());
  const newLines = newCode.split('\n').map(l => l.trimEnd());
  
  while(oldLines.length > 0 && !oldLines[oldLines.length-1].trim()) oldLines.pop();
  while(newLines.length > 0 && !newLines[0].trim()) newLines.shift();
  
  let bestOverlap = 0;
  const maxPossible = Math.min(oldLines.length, newLines.length);
  
  // Try to find the overlap backwards (largest possible overlap first)
  for (let overlap = maxPossible; overlap >= 1; overlap--) {
    let matchCount = 0;
    let totalChecked = 0;
    
    for (let i = 0; i < overlap; i++) {
      const line1 = oldLines[oldLines.length - overlap + i];
      const line2 = newLines[i];
      
      // Skip purely empty lines in scoring to avoid false positives
      if (!line1.trim() && !line2.trim()) continue;
      
      totalChecked++;
      if (isSimilarityHigh(line1, line2, errorTolerance)) {
        matchCount++;
      }
    }
    
    // If a significant percentage of lines match fuzzily, it's a solid overlap.
    if (totalChecked > 0 && (matchCount / totalChecked) >= (1 - errorTolerance)) {
      bestOverlap = overlap;
      break; 
    }
  }
  
  if (bestOverlap > 0) {
    const nonOverlapping = newLines.slice(bestOverlap);
    return [...oldLines, ...nonOverlapping].join('\n');
  }
  
  // If no overlap found at edges, verify if the new block is just completely embedded inside oldCode
  const newBlockJoined = newLines.join('\n').replace(/\s+/g,'');
  const oldBlockJoined = oldCode.replace(/\s+/g,'');
  if (newBlockJoined.length > 10 && oldBlockJoined.includes(newBlockJoined)) {
     return oldCode; // completely duplicate block, ignore it
  }
  
  // No overlap found, append sequentially
  return oldCode + '\n' + newLines.join('\n');
}

/**
 * String similarity checker allowing OCR typos
 */
function isSimilarityHigh(a: string, b: string, tolerance: number): boolean {
  if (a === b) return true;
  const ac = a.replace(/\s+/g, '').toLowerCase();
  const bc = b.replace(/\s+/g, '').toLowerCase();
  
  if (ac === bc) return true;
  if (!ac && !bc) return true;
  if (!ac || !bc) return false;
  
  const dist = levenshtein(ac, bc);
  const maxLen = Math.max(ac.length, bc.length);
  
  // if length is very small (like `}`), require exact match to avoid stitching wrong brackets
  if (maxLen < 4) return dist === 0;
  
  return dist <= Math.max(1, Math.floor(maxLen * tolerance));
}

/**
 * Standard Levenshtein distance for OCR typo detection
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      if (b.charAt(j - 1) === a.charAt(i - 1)) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i - 1] + 1, // substitution
          Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1) // insert & delete
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Final cleanup to remove immediately repeating lines (common OCR glitch)
 */
function cleanOutput(code: string): string {
  const lines = code.split('\n');
  const result = [];
  let lastLineClean = '';
  
  for (const l of lines) {
     const clean = l.replace(/\s+/g, '');
     // if line is identical to the exact previous line, skip it
     if (clean && clean === lastLineClean) continue; 
     if (clean) lastLineClean = clean;
     result.push(l);
  }
  
  return result.join('\n');
}
