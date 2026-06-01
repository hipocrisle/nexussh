import pkg from "@xterm/headless";
const { Terminal } = pkg;
import fs from "fs";

const raw = fs.readFileSync("/tmp/htop_cast.txt", "utf8");
const noAlt = raw.replace(/\x1b\[\?(?:1049|1048|1047|47)[hl]/g, "");
const t = new Terminal({ cols: 80, rows: 24, scrollback: 100000, allowProposedApi: true });
await new Promise((r) => t.write(noAlt, r));
const buf = t.buffer.active;
console.log("buffer length:", buf.length);
const lines = [];
for (let i = 0; i < buf.length; i++) {
  const ln = buf.getLine(i);
  if (ln) lines.push(ln.translateToString(true));
}
const dedup = [];
for (const ln of lines) if (dedup.length === 0 || dedup[dedup.length - 1] !== ln) dedup.push(ln);
while (dedup.length && !dedup[dedup.length - 1]) dedup.pop();
console.log("=== first 30 lines ===");
console.log(dedup.slice(0, 30).join("\n"));
console.log(`... [${dedup.length} total]`);
