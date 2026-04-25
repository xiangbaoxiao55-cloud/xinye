import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: '/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        diary: 'diary.html',
        reading: 'reading.html',
        choubao: 'choubao.html',
      }
    }
  },
  server: {
    port: 5173,
    open: false
  }
})
