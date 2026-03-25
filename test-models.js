import fs from "fs";
import path from "path";

// read .env
const envPath = path.resolve('.env');
const text = fs.readFileSync(envPath, 'utf8');
const match = text.match(/^(?:VITE_)?(?:GOOGLE|GEMINI)_API_KEY\s*=\s*(.*)$/m);
const apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');

const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=\${apiKey}`;

fetch(fetchUrl)
  .then(res => res.json())
  .then(data => {
    const models = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
    console.log("Supported Models for generateContent:");
    models.forEach(m => console.log(m.name));
  })
  .catch(err => console.error(err));
