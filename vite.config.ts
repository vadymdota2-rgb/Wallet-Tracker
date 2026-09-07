import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Сборка статики для nginx: контейнер — это nginx с папкой `html/`.
 *
 * Имена файлов с хешем обязательны. Прежняя сборка клала `routes.js` и
 * `live.js` без хеша, а nginx отдавал `/assets/` как неизменяемые на год:
 * после выката браузер брал новый `app.js` вместе с прошлогодним
 * `routes.js` и падал с «Unexpected end of input».
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD__: JSON.stringify(
      process.env.BUILD_NUMBER ?? new Date().toISOString().slice(0, 10),
    ),
  },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  /**
   * `npm run dev` отдаёт только статику: API, свечи и логотипы живут за
   * nginx. Проксируем их на уже выкаченный адрес, чтобы для локальной
   * работы не поднимать ни nginx, ни базы бота.
   *
   * Подписи Telegram в браузере нет, поэтому приложение само переходит на
   * публичный /api/market: кошельки и порог видны не будут, рынок и графики
   * будут. Свой адрес — переменной WT_PROXY.
   */
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/api", "/quotes", "/klines", "/klines-vision", "/klines-bybit", "/klines-kucoin",
       "/coins", "/hllogo", "/cglogo", "/pcslogo", "/twlogo"].map((path) => [
        path,
        {
          target: process.env.WT_PROXY ?? "https://wallet-tracker-git-606699497037.europe-west1.run.app",
          changeOrigin: true,
          secure: true,
        },
      ]),
    ),
  },
  build: {
    outDir: "html",
    // В html/ лежит coins/ — 1547 логотипов. Сборка их не трогает.
    emptyOutDir: false,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
