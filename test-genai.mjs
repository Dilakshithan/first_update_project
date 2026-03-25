import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

// 1. Read key
const envPath = path.resolve('.env');
let apiKey = "";
if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, 'utf8');
  const match = text.match(/^(?:VITE_)?(?:GOOGLE|GEMINI)_API_KEY\s*=\s*(.*)$/m);
  if (match && match[1]) {
    apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
  }
}

if (!apiKey) {
  console.error("No API key found in .env");
  process.exit(1);
}

console.log("Found key starting with:", apiKey.substring(0, 8), "length:", apiKey.length);

const ai = new GoogleGenAI({ apiKey });

async function test() {
  try {
    console.log("Sending ping to SDK...");
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: "Hello, what models are available to me?"
    });
    console.log("Success! Response:");
    console.log(response.text);
  } catch (err) {
    console.error("SDK Error details:");
    console.error(err);
  }
}

test();
