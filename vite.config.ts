import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
