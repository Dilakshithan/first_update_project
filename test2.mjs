import fs from "fs";
import path from "path";

const envPath = path.resolve('.env');
let apiKey = "";
const text = fs.readFileSync(envPath, 'utf8');
const match = text.match(/^(?:VITE_)?(?:GOOGLE|GEMINI)_API_KEY\s*=\s*(.*)$/m);
if (match && match[1]) {
  apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
}

console.log("Using fetch natively. Key starts with:", apiKey.substring(0, 8));

const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${apiKey}`;

try {
  const res = await fetch(fetchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Hello, test this." }] }]
    })
  });
  console.log(res.status, res.statusText);
  const body = await res.text();
  console.log(body);
} catch(e) { console.error(e) }
