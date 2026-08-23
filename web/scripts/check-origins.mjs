import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const html = readFileSync(resolve(dist, "index.html"), "utf8");

const allowed = new Set(["self"]);
let violations = 0;

for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (url.startsWith("/")) continue;
  if (/^https?:\/\//i.test(url)) {
    console.error(`THIRD-PARTY ORIGIN in index.html: ${url}`);
    violations += 1;
  }
}

for (const file of ["gone.html"]) {
  const content = readFileSync(resolve(dist, file), "utf8");
  for (const m of content.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/gi)) {
    console.error(`THIRD-PARTY ORIGIN in ${file}: ${m[1]}`);
    violations += 1;
  }
}
void allowed;

if (violations > 0) {
  console.error(`FAIL: ${violations} third-party origin reference(s)`);
  process.exit(1);
}
console.log("OK: zero third-party origins in shipped HTML");
