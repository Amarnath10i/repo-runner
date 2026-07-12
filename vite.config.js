import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WebContainers need the page to be "cross-origin isolated" (COOP/COEP headers).
// Without these headers, the browser won't allow the WebContainer runtime to boot.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  optimizeDeps: {
    exclude: ['@webcontainer/api'],
  },
});
