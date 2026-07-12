import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { resolve } from 'path';

const BACKEND_PORT = 3001;

/**
 * Check if a port is already in use.
 * Returns true if the port is occupied (backend already running).
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port }, () => {
      socket.destroy();
      resolve(true); // port in use
    });
    socket.on('error', () => {
      resolve(false); // port free
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Vite plugin that auto-starts the backend server when the dev server starts.
 * - Only spawns if port 3001 is not already in use
 * - Pipes stdout/stderr to the parent terminal
 * - Kills the child process on Vite shutdown
 */
function autoStartBackend() {
  let backendProcess = null;

  return {
    name: 'auto-start-backend',
    apply: 'serve', // only during dev, not build

    async configureServer(server) {
      const portBusy = await isPortInUse(BACKEND_PORT);

      if (portBusy) {
        console.log(`\n  ✓ Backend already running on port ${BACKEND_PORT}\n`);
        return;
      }

      console.log(`\n  ▸ Auto-starting backend server on port ${BACKEND_PORT}...`);

      const backendDir = resolve(process.cwd(), 'backend');

      backendProcess = spawn('node', ['server.js'], {
        cwd: backendDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(BACKEND_PORT) },
        shell: true,
      });

      backendProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim();
        if (lines) {
          for (const line of lines.split('\n')) {
            console.log(`  \x1b[2m[backend]\x1b[0m ${line}`);
          }
        }
      });

      backendProcess.stderr.on('data', (data) => {
        const lines = data.toString().trim();
        if (lines) {
          for (const line of lines.split('\n')) {
            console.log(`  \x1b[2m[backend]\x1b[0m \x1b[33m${line}\x1b[0m`);
          }
        }
      });

      backendProcess.on('error', (err) => {
        console.error(`  \x1b[31m[backend] Failed to start: ${err.message}\x1b[0m`);
      });

      backendProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          console.log(`  \x1b[33m[backend] Exited with code ${code}\x1b[0m`);
        }
        backendProcess = null;
      });

      // Kill backend when Vite shuts down
      const cleanup = () => {
        if (backendProcess && !backendProcess.killed) {
          console.log(`\n  ▸ Stopping backend server...`);
          backendProcess.kill('SIGTERM');
          backendProcess = null;
        }
      };

      // Only clean up when the entire Node process exits, not when Vite's 
      // internal HTTP server restarts (e.g., due to port conflicts).
      process.once('exit', cleanup);
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    },
  };
}

// WebContainers need the page to be "cross-origin isolated" (COOP/COEP headers).
// Without these headers, the browser won't allow the WebContainer runtime to boot.
export default defineConfig({
  plugins: [react(), autoStartBackend()],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    watch: {
      // Cloned repos and provisioned runtimes live under backend/ — don't let
      // the file watcher reload the runner UI every time we clone/run a repo.
      ignored: [
        '**/backend/.repos/**',
        '**/backend/.runtimes/**',
        '**/backend/node_modules/**',
      ],
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
