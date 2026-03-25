import Tesseract from "tesseract.js";

export async function extractTextOffline(canvas: HTMLCanvasElement): Promise<string> {
  try {
    const { data } = await Tesseract.recognize(canvas, "eng");
    const raw = data?.text || "";

    // 1. Try to extract numbered lines first, exactly like the old logic
    const numberedCandidates = parseFrameNumberedLines(raw);
    const trusted = filterTrustedNumberedLines(numberedCandidates);
    const shouldUseNumbered = detectNumberedMode(numberedCandidates, trusted);

    if (shouldUseNumbered && trusted.length > 0) {
      // Return only the sorted, perfectly parsed code text
      const ordered = trusted.sort((a, b) => a.lineNumber - b.lineNumber);
      return ordered.map(t => cleanCodeText(t.codeText)).filter(Boolean).join("\n");
    }

    // 2. Fallback to unnumbered mode extraction 
    const unnumberedLines = extractUnnumberedLines(raw);
    return unnumberedLines.join("\n");
  } catch (error) {
    console.error("Offline OCR Error:", error);
    return "";
  }
}

// ---------------------------------------------------------
// Below are the extraction heuristics from the old component
// ---------------------------------------------------------

interface ParsedLine {
  lineNumber: number;
  codeText: string;
  rawPrefix: string;
  rawLine: string;
}

function parseFrameNumberedLines(rawText: string): ParsedLine[] {
  const lines = (rawText || "").replace(/\r/g, "").split("\n");
  const out: ParsedLine[] = [];
  for (const line of lines) {
    const parsed = splitLineNumberAndCode(line);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

function splitLineNumberAndCode(rawLine: string): ParsedLine | null {
  const input = (rawLine || "").trim();
  if (!input) return null;

  const m = input.match(/^([~`'".,:;|!\[\](){}<>+\-_/\\A-Za-z0-9]{1,6})\s+(.*)$/);
  if (!m) return null;

  const rawPrefix = m[1];
  const codeText = cleanCodeText(m[2]);
  if (!codeText) return null;

  const lineNumber = parseLineNumber(rawPrefix);
  if (!lineNumber) return null;

  return { lineNumber, codeText, rawPrefix, rawLine: input };
}

function parseLineNumber(rawPrefix: string): number | null {
  const normalized = normalizeLineNumberText(rawPrefix);
  if (!normalized) return null;
  if (!/^\d{1,4}$/.test(normalized)) return null;

  const num = Number(normalized);
  if (!Number.isInteger(num) || num <= 0 || num > 5000) return null;
  return num;
}

function normalizeLineNumberText(rawPrefix: string): string {
  const src = (rawPrefix || "").trim();
  if (!src) return "";

  let mapped = "";
  for (const ch of src) {
    if (/\d/.test(ch)) {
      mapped += ch;
      continue;
    }
    // OCR confusions
    if (/[Oo]/.test(ch)) mapped += "0";
    else if (/[Il|]/.test(ch)) mapped += "1";
    else if (/[Ss]/.test(ch)) mapped += "5";
    else if (/[Bb]/.test(ch)) mapped += "8";
    else if (/[Zz]/.test(ch)) mapped += "2";
  }

  return mapped.replace(/^0+(\d)/, "$1");
}

function detectNumberedMode(numberedCandidates: ParsedLine[], trusted: ParsedLine[]) {
  if (Array.isArray(trusted) && trusted.length >= 2) return true;

  const nums = numberedCandidates.map((x) => x.lineNumber).filter((n) => Number.isInteger(n));
  const unique = new Set(nums);
  return unique.size >= 4;
}

function detectSequentialNumberBlock(numberedLines: ParsedLine[]): Set<number> {
  if (!Array.isArray(numberedLines) || numberedLines.length === 0) return new Set();
  const nums = [...new Set(numberedLines.map((x) => x.lineNumber))].sort((a, b) => a - b);
  const trusted = new Set<number>();

  let run = [nums[0]];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) run.push(nums[i]);
    else {
      if (run.length >= 2) run.forEach((n) => trusted.add(n));
      run = [nums[i]];
    }
  }
  if (run.length >= 2) run.forEach((n) => trusted.add(n));
  return trusted;
}

function filterTrustedNumberedLines(numberedLines: ParsedLine[]): ParsedLine[] {
  const seqTrusted = detectSequentialNumberBlock(numberedLines);

  return numberedLines.filter((x) => {
    if (!x || !x.codeText) return false;
    // We treat sequential blocks as highly trusted
    if (seqTrusted.size > 0 && seqTrusted.has(x.lineNumber)) return true;
    return false;
  });
}

function cleanCodeText(text: string): string {
  const t = (text || "").replace(/[ \t]+/g, " ").trim();
  if (!t) return "";
  if (/^[|:.,;`'"]+$/.test(t)) return "";
  return t;
}

function extractUnnumberedLines(rawText: string): string[] {
  return (rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(cleanOcrLine)
    .filter((l) => l && !isUnnumberedNoiseLine(l));
}

function cleanOcrLine(line: string): string {
  return (line || "")
    .replace(/[ \t]+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function isUnnumberedNoiseLine(line: string): boolean {
  const t = (line || "").trim();
  if (!t) return true;
  if (/^[|:.,;`'"]+$/.test(t)) return true;
  if (/^\d{1,4}$/.test(t)) return true; // standalone numbers are likely noise
  return false;
}
