// Rig keys: one RSA pair for the fake Access door. The public
// half is served by certs-server.mjs as the certs document; the
// private half signs the tokens mint.mjs makes. The generated
// files (jwk.json, private.pem) are gitignored — run this first.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "rig1";
jwk.alg = "RS256";
jwk.use = "sig";
writeFileSync(new URL("./jwk.json", import.meta.url), JSON.stringify({ keys: [jwk] }));
writeFileSync(
  new URL("./private.pem", import.meta.url),
  privateKey.export({ format: "pem", type: "pkcs8" })
);
console.log("rig keys written");
