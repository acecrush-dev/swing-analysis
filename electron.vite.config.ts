import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        // Plan 004 — multi-entry renderer: index.html is the main
        // window; clips.html / log.html are the two detachable panel
        // windows. Each one is a self-contained HTML entry that vite
        // picks up because their <script> tag points at a TSX file.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          clips: resolve(__dirname, 'src/renderer/clips.html'),
          log: resolve(__dirname, 'src/renderer/log.html'),
        }
      }
    },
    server: {
      // Plan 004 — dev HMR for the two new panel entries.
      // Vite picks these up automatically from the rollupOptions.input
      // map; we just need to make sure the dev server can be reached
      // by the panel BrowserWindows (already happens — they use
      // ELECTRON_RENDERER_URL + '/clips.html').
    },
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react()]
  }
});