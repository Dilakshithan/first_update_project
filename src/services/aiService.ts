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
