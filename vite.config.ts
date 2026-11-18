import { defineConfig } from 'vite';

// The browser client lives in client/; it imports the engine straight from src/engine.
export default defineConfig({
  root: 'client',
  // The voice engine (kokoro-js) is a ~2 MB chunk, loaded only when voices are switched on.
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    // Same headers as the game server: multi-threaded WebAssembly for the voice engine.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' },
    // `npm run dev:client` talks to a game server started with `npm run server`.
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
