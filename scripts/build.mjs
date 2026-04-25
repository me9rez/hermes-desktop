#!/usr/bin/env node
"use strict";

import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [resolve(rootDir, "src", "main.ts")],
  outfile: resolve(distDir, "main.js"),
  external: ["electron", "electron-updater"],
});

await esbuild.build({
  ...common,
  entryPoints: [resolve(rootDir, "src", "preload.ts")],
  outfile: resolve(distDir, "preload.js"),
  external: ["electron"],
});
