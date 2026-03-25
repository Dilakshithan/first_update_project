/**
 * Simple line-based merging algorithm.
 * It tries to find the longest overlapping sequence of lines at the end of oldCode
 * and the beginning of newCode.
 */
export function mergeCode(oldCode: string, newCode: string): string {
  if (!oldCode) return newCode;
  if (!newCode) return oldCode;

  const oldLines = oldCode.split('\n').map(l => l.trimEnd());
  const newLines = newCode.split('\n').map(l => l.trimEnd());

  // Remove empty lines at start/end for better matching
  while (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  while (newLines.length > 0 && newLines[0] === '') newLines.shift();

  let maxOverlap = 0;
  const maxPossibleOverlap = Math.min(oldLines.length, newLines.length);

  // Try to find the overlap
  for (let overlap = 1; overlap <= maxPossibleOverlap; overlap++) {
    let isMatch = true;
    for (let i = 0; i < overlap; i++) {
      // Compare the last 'overlap' lines of oldCode with the first 'overlap' lines of newCode
      // Allow some fuzziness (e.g. OCR errors) by calculating Levenshtein distance or just exact match for now
      if (oldLines[oldLines.length - overlap + i] !== newLines[i]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      maxOverlap = overlap;
    }
  }

  // If we found an overlap, append only the non-overlapping part of newCode
  if (maxOverlap > 0) {
    const nonOverlappingNewLines = newLines.slice(maxOverlap);
    return [...oldLines, ...nonOverlappingNewLines].join('\n');
  }

  // If no overlap, maybe it's completely new code (e.g., scrolled down a lot)
  // Or maybe OCR just failed to match perfectly.
  // For a robust system, we'd use LCS. Here's a basic fallback: just append with a separator
  // if it looks completely different, or replace if it looks like a better version of the same.
  
  // As a simple heuristic, if they share many lines anywhere, it might be an update.
  // For now, if no overlap at the edges, we just append it.
  return oldCode + '\n' + newCode;
}
