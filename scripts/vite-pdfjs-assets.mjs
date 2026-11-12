// Ships the PDF.js runtime data the reader needs *offline*.
//
// The reader (issue #31) renders with `pdfjs-dist`, which fetches four kinds of
// auxiliary files at runtime: base-14 standard fonts, Adobe CMaps (CJK text),
// the wasm image decoders (JPX/JBIG2) and an ICC profile for colour conversion.
// Fetching them from a CDN would break the "no remote resource" contract, so
// they are emitted from the installed package into the app's own `dist` and the
// reader points every URL at that directory.
//
// Nothing here reaches a startup chunk: the reader is a lazy chunk, the worker
// is a separate on-demand file, and these data files are static assets. The PDF
// worker has its own `size-limit` entry so it stays a visible, bounded cost
// rather than hiding outside the client-JS budget.
//
// The wasm/JS pair is verbatim from `pdfjs-dist` (Apache-2.0); its licence files
// are emitted alongside it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE = path.join(ROOT, "node_modules/pdfjs-dist");

/** Directories `pdfjs-dist` expects at runtime, under `/pdfjs/`. */
const DIRECTORIES = ["standard_fonts", "cmaps", "wasm", "iccs"];

/** The worker the reader loads on demand (its own bounded asset). */
const WORKER = path.join(PACKAGE, "build/pdf.worker.min.mjs");

function collect(directory) {
  const absolute = path.join(PACKAGE, directory);
  try {
    statSync(absolute);
  } catch {
    throw new Error(
      `pdfjs assets: ${directory} is missing from pdfjs-dist; run pnpm install`,
    );
  }
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const from = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(from, relative);
      else files.push({ absolute: from, relative });
    }
  };
  walk(absolute, "");
  return files;
}

/**
 * @param {{ mount?: string }} [options] `mount` is the URL prefix the emitted
 * files are served from (default `/pdfjs`, matching `import.meta.env.BASE_URL`).
 */
export function pdfjsAssets(options = {}) {
  const mount = options.mount ?? "pdfjs";
  let files = [];
  return {
    name: "terax-pdfjs-assets",
    buildStart() {
      files = DIRECTORIES.flatMap((directory) =>
        collect(directory).map((file) => ({
          ...file,
          relative: `${directory}/${file.relative}`,
        })),
      );
      files.push({ absolute: WORKER, relative: "pdf.worker.min.mjs" });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `${mount}/${file.relative}`,
          source: readFileSync(file.absolute),
        });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const prefix = `/${mount}/`;
        const url = request.url ?? "";
        if (!url.startsWith(prefix)) return next();
        const relative = decodeURIComponent(url.slice(prefix.length).split("?")[0]);
        const target =
          relative === "pdf.worker.min.mjs"
            ? WORKER
            : path.join(PACKAGE, relative);
        if (!target.startsWith(PACKAGE)) return next();
        try {
          const body = readFileSync(target);
          response.setHeader(
            "Content-Type",
            relative.endsWith(".wasm")
              ? "application/wasm"
              : relative.endsWith(".mjs")
                ? "text/javascript"
                : "application/octet-stream",
          );
          response.end(body);
        } catch {
          next();
        }
      });
    },
  };
}
