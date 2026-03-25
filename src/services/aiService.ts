import { GoogleGenAI } from "@google/genai";

// 1. We store the AI instance outside the function so we only initialize it once
let ai: GoogleGenAI | null = null;

// 2. This is the EXACT function that handles the API key in Antigravity
export function getAI() {
  if (!ai) {
    // Antigravity automatically injects this environment variable.
    // DO NOT use import.meta.env for the Gemini key in this environment.
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set by the environment");
    }
    
    // Initialize the client with the key
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

// 3. Then, inside your extraction function, you just call getAI()
export async function extractTextOnline(canvas: HTMLCanvasElement): Promise<string> {
  try {
    // Grab the initialized client
    const aiClient = getAI();
    
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64EncodeString = dataUrl.split(',')[1];

    // Call the API
    const response = await aiClient.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64EncodeString } },
          { text: "Extract only the programming code from this image. Return only the clean code." },
        ],
      },
      config: { temperature: 0.1 }
    });

    let text = response.text || '';
    text = text.replace(/^```[\w]*\n/m, '').replace(/\n```$/m, '');
    return text.trim();
  } catch (error) {
    console.error("Online AI Extraction Error:", error);
    return "";
  }
}

export async function mergeCodeBlocksOnline(blocks: string[]): Promise<string> {
  if (!blocks || blocks.length === 0) return "";
  if (blocks.length === 1) return blocks[0];

  try {
    const aiClient = getAI();
    
    const prompt = `You are an expert software engineer.

The following text is extracted from a video using OCR. It contains:
- duplicate code blocks
- partial/incomplete fragments
- repeated sections
- unordered lines

Your task is to reconstruct ONE clean, complete, correct program.

STRICT RULES:
1. Keep ONLY ONE final version of the code.
2. Remove ALL duplicate blocks completely.
3. Merge fragments into a single correct structure.
4. If multiple versions exist, choose the MOST COMPLETE one.
5. Maintain correct order of statements.
6. Fix syntax errors if needed.
7. Keep proper indentation and formatting.
8. Do NOT repeat any code.
9. Do NOT output multiple versions.
10. Output ONLY the final clean code.

IMPORTANT:
- There must be ONLY ONE "main" method.
- There must be ONLY ONE class definition.
- Remove any incomplete or broken lines.

If the code appears multiple times, DO NOT include all versions.
ONLY return the best and most complete version.

Return ONLY code. No explanations.

Here are the extracted blocks:
${blocks.map((block, i) => `\n--- BLOCK ${i + 1} ---\n${block}`).join('\n')}
`;

    const response = await aiClient.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        temperature: 0.1,
      }
    });

    let text = response.text || '';
    text = text.replace(/^```[\w]*\n/m, '').replace(/\n```$/m, '');
    return text.trim();
  } catch (error) {
    console.error("Online AI Merge Error:", error);
    // Fallback to simple concatenation if AI fails
    return blocks.join('\n\n/* --- Next Frame --- */\n\n');
  }
}
