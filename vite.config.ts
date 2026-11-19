import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

function publicData(): Plugin {
  const src = path.resolve(__dirname, "public-data");
  const dest = path.resolve(__dirname, "public/public-data");
  const copy = () => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const from = path.join(src, f);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, f));
    }
  };
  return { name: "public-data", buildStart: copy, configureServer: copy };
}

export default defineConfig({
  base: "/trading-dashboard/",
  plugins: [react(), publicData()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
