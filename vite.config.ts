import { defineConfig } from "vite";

const defaultBase = process.env.GITHUB_ACTIONS ? "/map-color-war-h5/" : "/";
const base = process.env.VITE_BASE ?? defaultBase;

export default defineConfig({
  base,
  server: {
    port: 5173,
    strictPort: false
  },
  preview: {
    port: 4173,
    strictPort: false
  }
});
