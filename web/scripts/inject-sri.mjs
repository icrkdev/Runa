import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/// Post-build SRI injection over the FINAL files on disk. Runs after
/// `vite build` (see package.json). Hashing written bytes — not in-memory
/// bundles — is what makes the digest match what the server serves; a
/// mismatch here previously caused Chrome to block our own entry chunk.
const base = resolve(process.cwd(), "dist");
const htmlPath = resolve(base, "index.html");
let html = readFileSync(htmlPath, "utf8");

let patched = 0;
html = html.replace(
  /<(script|link)\b([^>]*?)\s(src|href)="(\/[^"]+)"([^>]*)>/g,
  (match, tag, before, attr, asset, after) => {
    if (/integrity=/.test(match)) return match;
    const file = resolve(base, asset.slice(1).split("?")[0]);
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return match;
    }
    const hash = `sha384-${createHash("sha384").update(buf).digest("base64")}`;
    let attrs = `${before} ${attr}="${asset}"${after}`;
    if (!attrs.includes("crossorigin")) attrs = ` crossorigin="anonymous"${attrs}`;
    patched += 1;
    return `<${tag}${attrs} integrity="${hash}">`;
  },
);

if (patched === 0) throw new Error("inject-sri: no asset tags patched — build layout changed?");
writeFileSync(htmlPath, html);
console.log(`SRI: injected sha384 integrity into ${patched} asset tags`);
