import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.NOVNC_DIR ?? "/usr/share/novnc";
const target = join(directory, "vnc.html");
const responsiveTag = '<script src="pimuse-responsive.js"></script>';
const desktopTag = '<script type="module" crossorigin="anonymous" src="viewer-desktop.js"></script>';
const originalUiTag = /<script\s+type=["']module["'][^>]*src=["']app\/ui\.js["'][^>]*><\/script>/;

let html = await readFile(target, "utf8");
if (!html.includes("</head>")) throw new Error("noVNC vnc.html has no closing head tag");
if (!html.includes(desktopTag)) {
  if (!originalUiTag.test(html)) throw new Error("noVNC vnc.html has no official app/ui.js module entry");
  html = html.replace(originalUiTag, desktopTag);
}
if (!html.includes(responsiveTag)) html = html.replace("</head>", `    ${responsiveTag}\n</head>`);
await writeFile(target, html);
