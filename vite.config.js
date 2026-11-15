import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// base: './' — чтобы готовый сайт работал из любой папки (например, на GitHub Pages)
export default defineConfig({
  base: './',
  resolve: {
    // своя копия библиотеки графиков с правкой: цены шкалы не налезают на метки (см. src/vendor)
    alias: { 'lightweight-charts': fileURLToPath(new URL('./src/vendor/lightweight-charts.mjs', import.meta.url)) },
  },
})
