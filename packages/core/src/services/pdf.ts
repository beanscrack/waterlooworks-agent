import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WWError } from "../errors.js";

const run = promisify(execFile);

export interface GrayPage {
  width: number;
  height: number;
  data: Buffer;
}

let popplerChecked = false;
/** WaterlooWorks exposes application packages only as merged PDFs; we identify their parts by rendering. */
export async function ensurePoppler(): Promise<void> {
  if (popplerChecked) return;
  try {
    await run("pdftoppm", ["-v"]);
    await run("pdfinfo", ["-v"]);
    popplerChecked = true;
  } catch {
    throw new WWError("poppler-utils (pdftoppm, pdfinfo) is required to analyse application packages. Install it and retry.", "MISSING_DEPENDENCY");
  }
}

export async function pdfPageCount(file: string): Promise<number> {
  await ensurePoppler();
  const { stdout } = await run("pdfinfo", [file]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new WWError(`Could not read page count of ${file}`, "PDF_ERROR");
  return Number(m[1]);
}

/** Render every page to greyscale at a low DPI. Deterministic for identical content streams. */
export async function renderPdf(file: string, dpi = 36): Promise<GrayPage[]> {
  await ensurePoppler();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-render-"));
  try {
    await run("pdftoppm", ["-gray", "-r", String(dpi), file, path.join(dir, "p")]);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".pgm")).sort();
    return files.map((f) => parsePgm(fs.readFileSync(path.join(dir, f))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parsePgm(buf: Buffer): GrayPage {
  // P5\n<w> <h>\n<max>\n<data>
  const header = buf.subarray(0, 64).toString("latin1");
  const m = header.match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) throw new WWError("Unexpected PGM output from pdftoppm", "PDF_ERROR");
  const width = Number(m[1]);
  const height = Number(m[2]);
  const data = buf.subarray(m[0].length, m[0].length + width * height);
  return { width, height, data };
}

/**
 * Similarity over "ink" pixels only (grey < 230 on either page), so two mostly-blank pages
 * cannot look alike. Returns 0 when dimensions differ or neither page has meaningful ink.
 */
export function pageSimilarity(a: GrayPage, b: GrayPage, tolerance = 40): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const n = a.data.length;
  let ink = 0;
  let same = 0;
  for (let i = 0; i < n; i++) {
    const x = a.data[i];
    const y = b.data[i];
    if (x < 230 || y < 230) {
      ink++;
      if (Math.abs(x - y) <= tolerance) same++;
    }
  }
  if (ink < n * 0.002) return 0;
  return same / ink;
}

/** Index in `hay` where all pages of `needle` appear consecutively (similarity ≥ threshold), else -1. */
export function findSequence(needle: GrayPage[], hay: GrayPage[], threshold = 0.97): number {
  if (!needle.length || needle.length > hay.length) return -1;
  outer: for (let s = 0; s + needle.length <= hay.length; s++) {
    for (let i = 0; i < needle.length; i++) if (pageSimilarity(needle[i], hay[s + i]) < threshold) continue outer;
    return s;
  }
  return -1;
}
