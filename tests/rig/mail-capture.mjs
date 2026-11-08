// The mail capture for the email drill: a stand-in for the
// shared mail service, on port 8795 (RIG_MAIL_PORT moves it).
// The rig Worker is configured with MAIL_SEND_URL pointed
// here, so every link the Worker sends lands in this process's
// memory — the drill reads the link out of the captured
// message and spends it, which is the rig's proof that a send
// carries a working link. POST /send records a message (and
// answers 202, the service's own shape); GET /messages answers
// the recorded messages as JSON; POST /clear empties the box.
import { createServer } from "node:http";

const PORT = Number(process.env.RIG_MAIL_PORT) || 8795;
const messages = [];

export function startMailCapture(port) {
  const server = createServer((req, res) => {
    if (req.url === "/send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded raw below */ }
        messages.push({ at: Date.now(), headers: req.headers, body: parsed, raw: body });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "capture-" + messages.length, status: "queued" }));
      });
      return;
    }
    if (req.url === "/messages" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(messages));
      return;
    }
    if (req.url === "/clear" && req.method === "POST") {
      messages.length = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) => {
    server.listen(port || PORT, "127.0.0.1", () => resolve(server));
  });
}

// Reads the messages the capture holds right now.
export async function capturedMessages(port) {
  const res = await fetch("http://127.0.0.1:" + (port || PORT) + "/messages");
  return res.json();
}

export async function clearCaptured(port) {
  await fetch("http://127.0.0.1:" + (port || PORT) + "/clear", { method: "POST" });
}
