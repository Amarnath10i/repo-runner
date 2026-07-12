// Auto-provision runtimes that aren't installed on the host machine.
// Downloads portable/standalone builds so projects "just work" without
// requiring the user to install Python, Go, etc. manually.

import { execSync, spawn as nodeSpawn } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, createWriteStream, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import https from 'https';
import http from 'http';

const PROVISION_DIR = join(process.cwd(), '.runtimes');

// ─── Python Provisioning ───

const PYTHON_VERSION = '3.12.4';
const PYTHON_DIR = join(PROVISION_DIR, 'python');
const PYTHON_MARKER = join(PYTHON_DIR, '.provisioned');

// Python embeddable package URLs
const PYTHON_URLS = {
  'win32-x64': `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  'win32-ia32': `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-win32.zip`,
  'linux-x64': `https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz`,
  'darwin-x64': `https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz`,
};

const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

/**
 * Check if Python has been provisioned already.
 */
export function isPythonProvisioned() {
  return existsSync(PYTHON_MARKER);
}

/**
 * Get the path to the provisioned Python executable.
 */
export function getProvisionedPythonPath() {
  if (!isPythonProvisioned()) return null;
  const isWin = process.platform === 'win32';
  return isWin ? join(PYTHON_DIR, 'python.exe') : join(PYTHON_DIR, 'bin', 'python3');
}

/**
 * Get the path to provisioned pip.
 */
export function getProvisionedPipPath() {
  if (!isPythonProvisioned()) return null;
  const pythonPath = getProvisionedPythonPath();
  return `"${pythonPath}" -m pip`;
}

/**
 * Download a file with progress reporting.
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;

    const doDownload = (downloadUrl) => {
      proto.get(downloadUrl, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        const fileStream = createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            onProgress?.(`  Downloading... ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)}MB)\r`);
          }
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          onProgress?.(`  Download complete (${(downloadedBytes / 1024 / 1024).toFixed(1)}MB)\n`);
          resolve();
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    };

    doDownload(url);
  });
}

/**
 * Extract a zip file (Windows).
 */
function extractZip(zipPath, destDir) {
  // Use PowerShell's built-in Expand-Archive
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`,
    { stdio: 'ignore', timeout: 120000 }
  );
}

/**
 * Provision Python automatically.
 * Downloads the embeddable package and sets up pip.
 */
export async function provisionPython(onOutput) {
  if (isPythonProvisioned()) {
    const pythonPath = getProvisionedPythonPath();
    onOutput?.(`✓ Python already provisioned at ${pythonPath}\n`);
    return pythonPath;
  }

  const isWin = process.platform === 'win32';
  const arch = process.arch;
  const platformKey = `${process.platform}-${arch}`;

  if (!isWin) {
    // For now, auto-provisioning only supports Windows embeddable package
    // Linux/macOS users typically have Python installed or can install easily
    throw new Error(
      'Auto-provisioning Python is only supported on Windows. ' +
      'Please install Python manually: https://www.python.org/downloads/'
    );
  }

  const downloadUrl = PYTHON_URLS[platformKey];
  if (!downloadUrl) {
    throw new Error(`No Python download available for ${platformKey}`);
  }

  onOutput?.(`\n🐍 Python not found — auto-downloading Python ${PYTHON_VERSION}...\n`);

  // Create directories
  mkdirSync(PYTHON_DIR, { recursive: true });

  const zipPath = join(PROVISION_DIR, `python-${PYTHON_VERSION}.zip`);

  try {
    // Step 1: Download Python embeddable package
    onOutput?.(`  Downloading from python.org...\n`);
    await downloadFile(downloadUrl, zipPath, onOutput);

    // Step 2: Extract
    onOutput?.(`  Extracting Python...\n`);
    extractZip(zipPath, PYTHON_DIR);

    // Step 3: Enable pip by modifying the ._pth file
    // The embeddable package ships with a python3XX._pth that blocks pip
    const pthFiles = require('fs').readdirSync(PYTHON_DIR).filter(f => f.endsWith('._pth'));
    for (const pthFile of pthFiles) {
      const pthPath = join(PYTHON_DIR, pthFile);
      let content = readFileSync(pthPath, 'utf8');
      // Uncomment 'import site' to enable pip
      content = content.replace(/^#\s*import site/m, 'import site');
      // Also add Lib\site-packages
      if (!content.includes('Lib\\site-packages')) {
        content += '\nLib\\site-packages\n';
      }
      writeFileSync(pthPath, content);
    }

    // Step 4: Download and install pip
    onOutput?.(`  Installing pip...\n`);
    const getPipPath = join(PROVISION_DIR, 'get-pip.py');
    await downloadFile(GET_PIP_URL, getPipPath, onOutput);

    const pythonExe = join(PYTHON_DIR, 'python.exe');
    execSync(`"${pythonExe}" "${getPipPath}" --no-warn-script-location`, {
      cwd: PYTHON_DIR,
      stdio: 'pipe',
      timeout: 120000,
    });

    // Step 5: Install venv support (needed for isolated project environments)
    onOutput?.(`  Setting up virtual environment support...\n`);

    // Step 6: Mark as provisioned
    writeFileSync(PYTHON_MARKER, JSON.stringify({
      version: PYTHON_VERSION,
      provisionedAt: new Date().toISOString(),
      platform: platformKey,
    }));

    // Clean up zip
    try { unlinkSync(zipPath); } catch {}
    try { unlinkSync(join(PROVISION_DIR, 'get-pip.py')); } catch {}

    onOutput?.(`\n✅ Python ${PYTHON_VERSION} installed successfully!\n`);
    onOutput?.(`  Location: ${PYTHON_DIR}\n\n`);

    return pythonExe;
  } catch (err) {
    onOutput?.(`\n❌ Failed to provision Python: ${err.message}\n`);
    // Clean up on failure
    try { unlinkSync(zipPath); } catch {}
    throw err;
  }
}

/**
 * Invalidate the runtime cache (call after provisioning).
 */
export function invalidateRuntimeCache() {
  // This is imported and called from native-runner.js
}
