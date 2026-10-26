import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.NOVNC_DIR ?? "/usr/share/novnc";
const target = join(directory, "vnc.html");
const marker = "pimuse-responsive.js";
const tag = '<script src="pimuse-responsive.js"></script>';

let html = await readFile(target, "utf8");
if (!html.includes(marker)) {
  if (!html.includes("</head>")) throw new Error("noVNC vnc.html has no closing head tag");
  html = html.replace("</head>", `    ${tag}\n</head>`);
  await writeFile(target, html);
}
