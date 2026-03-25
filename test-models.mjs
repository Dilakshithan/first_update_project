import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const ai = new GoogleGenAI({ apiKey: "AIzaSyAjGWXzRhln5cSHLA_U92x1zDb45YiLy2E" });

async function run() {
  try {
    const list = await ai.models.list(); // or listModels() depending on the SDK version
    let out = "";
    for await (const model of list) {
        out += model.name + "\n";
    }
    fs.writeFileSync("models.txt", out);
  } catch (err) {
    console.error("Error listing models:", err);
  }
}

run();
