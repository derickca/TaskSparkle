// Fake Access certs endpoint for the Worker rig: serves the rig
// JWKS at the path the Worker fetches from its team domain,
// <ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs. Port 8791, or the
// RIG_CERTS_PORT value rig.mjs starts it with.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.RIG_CERTS_PORT) || 8791;
const jwks = readFileSync(new URL("./jwk.json", import.meta.url), "utf8");
createServer((req, res) => {
  if (req.url === "/cdn-cgi/access/certs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(jwks);
  } else {
    res.writeHead(404);
    res.end("nope");
  }
}).listen(PORT, "127.0.0.1", () => console.log("certs server on " + PORT));
