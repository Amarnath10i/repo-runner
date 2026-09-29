// Auto-provision runtimes that aren't installed on the host machine.
// Downloads portable/standalone builds into backend/.runtimes so projects
// "just work" without the user installing Python, Java, PHP, etc. manually.
//
// Each tool is described once in TOOLS (download URL per platform + the binary
// to look for). ensureTool() downloads and extracts it on first use and returns
// the bin directory (to prepend to PATH) plus any env vars the tool needs.

import { execSync, spawn } from 'child_process';
import { join, dirname, relative, resolve } from 'path';
import {
  existsSync, mkdirSync, createWriteStream, unlinkSync, readFileSync, writeFileSync,
  readdirSync, chmodSync,
} from 'fs';
import https from 'https';
import http from 'http';

const IS_WIN = process.platform === 'win32';
const PROVISION_DIR = defaultProvisionDir();

/**
 * Where runtimes live. Normally backend/.runtimes, but MinGW (used for C/C++
 * and Rust on Windows) can't link from a path containing spaces, so on
 * Windows fall back to a space-free folder. REPO_RUNNER_RUNTIMES overrides.
 */
function defaultProvisionDir() {
  if (process.env.REPO_RUNNER_RUNTIMES) return process.env.REPO_RUNNER_RUNTIMES;
  const local = join(process.cwd(), '.runtimes');
  if (!IS_WIN || !/\s/.test(local)) return local;
  const appData = process.env.LOCALAPPDATA;
  if (appData && !/\s/.test(appData)) return join(appData, 'repo-runner', 'runtimes');
  return join(process.env.SystemDrive || 'C:', 'repo-runner-runtimes');
}
const PLATFORM = `${process.platform}-${process.arch}`;
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

// Versions are pinned where the download URL needs one, so a runner that
// worked yesterday downloads the same thing today.
const GO_VERSION = '1.23.4';
const MAVEN_VERSION = '3.9.9';
const GRADLE_VERSION = '8.10.2';
const PHP_BRANCH = '8.3';
const RUBY_RELEASE = '3.3.12-1';
const WINLIBS_RELEASE = '16.2.0posix-14.0.0-ucrt-r1';
const WINLIBS_ZIP = 'winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r1.zip';

const adoptium = (version, os, arch) =>
  `https://api.adoptium.net/v3/binary/latest/${version}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;

/** A Temurin JDK tool definition. Old Gradle wrappers need an older JDK. */
function jdk(version) {
  return {
    label: `Java ${version} (Temurin JDK)`,
    icon: '☕',
    urls: {
      'win32-x64': adoptium(version, 'windows', 'x64'),
      'linux-x64': adoptium(version, 'linux', 'x64'),
      'linux-arm64': adoptium(version, 'linux', 'aarch64'),
      'darwin-x64': adoptium(version, 'mac', 'x64'),
      'darwin-arm64': adoptium(version, 'mac', 'aarch64'),
    },
    archive: IS_WIN ? '.zip' : '.tar.gz',
    bin: exe('javac'),
    // JAVA_HOME is the folder above bin/ (on macOS that's Contents/Home).
    env: (binDir) => ({ JAVA_HOME: dirname(binDir) }),
  };
}

const TOOLS = {
  // uv manages Python itself: it downloads a standalone CPython per project
  // (defaulting to a version with broad wheel support) and creates the venv.
  uv: {
    label: 'uv (Python manager)',
    icon: '🐍',
    urls: {
      'win32-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
      'linux-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
      'linux-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz',
      'darwin-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
      'darwin-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
    },
    bin: exe('uv'),
    env: () => ({ UV_PYTHON_INSTALL_DIR: join(PROVISION_DIR, 'uv-python') }),
  },
  go: {
    label: `Go ${GO_VERSION}`,
    icon: '🔵',
    urls: {
      'win32-x64': `https://go.dev/dl/go${GO_VERSION}.windows-amd64.zip`,
      'linux-x64': `https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz`,
      'linux-arm64': `https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz`,
      'darwin-x64': `https://go.dev/dl/go${GO_VERSION}.darwin-amd64.tar.gz`,
      'darwin-arm64': `https://go.dev/dl/go${GO_VERSION}.darwin-arm64.tar.gz`,
    },
    bin: exe('go'),
  },
  java: jdk(21),
  java17: jdk(17),
  java11: jdk(11),
  java8: jdk(8),
  maven: {
    label: `Maven ${MAVEN_VERSION}`,
    icon: '☕',
    urls: anyPlatform(`https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.zip`),
    bin: IS_WIN ? 'mvn.cmd' : 'mvn',
    requires: ['java'],
  },
  gradle: {
    label: `Gradle ${GRADLE_VERSION}`,
    icon: '🐘',
    urls: anyPlatform(`https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`),
    bin: IS_WIN ? 'gradle.bat' : 'gradle',
    requires: ['java'],
  },
  php: {
    label: `PHP ${PHP_BRANCH}`,
    icon: '🐘',
    // Windows builds move to /archives once superseded, so resolve the
    // current patch release from the official index at download time.
    urls: { 'win32-x64': resolvePhpUrl },
    archive: '.zip',
    bin: 'php.exe',
    setup: setupPhp,
  },
  ruby: {
    label: `Ruby ${RUBY_RELEASE.split('-')[0]}`,
    icon: '💎',
    urls: {
      'win32-x64': `https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-${RUBY_RELEASE}/rubyinstaller-${RUBY_RELEASE}-x64.7z`,
    },
    bin: 'ruby.exe',
  },
  cpp: {
    label: 'GCC / MinGW-w64 (C/C++ toolchain)',
    icon: '🔧',
    urls: {
      'win32-x64': `https://github.com/brechtsanders/winlibs_mingw/releases/download/${WINLIBS_RELEASE}/${WINLIBS_ZIP}`,
    },
    bin: 'g++.exe',
  },
  bun: {
    label: 'Bun',
    icon: '🥟',
    urls: {
      'win32-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip',
      'linux-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip',
      'linux-arm64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-linux-aarch64.zip',
      'darwin-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip',
      'darwin-arm64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip',
    },
    bin: exe('bun'),
  },
  deno: {
    label: 'Deno',
    icon: '🦕',
    urls: {
      'win32-x64': 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
      'linux-x64': 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip',
      'linux-arm64': 'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-unknown-linux-gnu.zip',
      'darwin-x64': 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip',
      'darwin-arm64': 'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip',
    },
    bin: exe('deno'),
  },
  // Rust is installed through rustup-init rather than an archive.
  rust: {
    label: 'Rust (stable)',
    icon: '🦀',
    urls: {
      'win32-x64': 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
      'linux-x64': 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init',
      'linux-arm64': 'https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init',
      'darwin-x64': 'https://static.rust-lang.org/rustup/dist/x86_64-apple-darwin/rustup-init',
      'darwin-arm64': 'https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init',
    },
    bin: exe('cargo'),
    install: installRust,
    env: () => ({
      RUSTUP_HOME: join(PROVISION_DIR, 'rust', 'rustup'),
      CARGO_HOME: join(PROVISION_DIR, 'rust', 'cargo'),
    }),
  },
};

function anyPlatform(url) {
  return Object.fromEntries(
    ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].map((k) => [k, url])
  );
}

/** Can this tool be auto-provisioned on this machine? */
export function canProvision(name) {
  const tool = TOOLS[name];
  if (!tool?.urls[PLATFORM]) return false;
  return (tool.requires || []).every(canProvision);
}

function markerPath(name) {
  return join(PROVISION_DIR, name, '.provisioned');
}

function readMarker(name) {
  try {
    const marker = JSON.parse(readFileSync(markerPath(name), 'utf8'));
    // binDir is stored relative to PROVISION_DIR so the folder can be moved.
    return { ...marker, binDir: resolve(PROVISION_DIR, marker.binDir) };
  } catch {
    return null;
  }
}

export function isProvisioned(name) {
  const marker = readMarker(name);
  return !!marker && existsSync(join(marker.binDir, TOOLS[name].bin));
}

/**
 * Env additions for an already-provisioned tool (and the tools it requires):
 * { pathDirs: [...], vars: {...} }, or null when it isn't provisioned.
 */
export function getProvisionedEnv(name) {
  if (!isProvisioned(name)) return null;
  const tool = TOOLS[name];
  const { binDir } = readMarker(name);
  const pathDirs = [binDir];
  let vars = tool.env ? tool.env(binDir) : {};
  for (const dep of tool.requires || []) {
    const depEnv = getProvisionedEnv(dep);
    if (depEnv) {
      pathDirs.push(...depEnv.pathDirs);
      vars = { ...depEnv.vars, ...vars };
    }
  }
  return { pathDirs, vars };
}

// Concurrent runs of the same repo type share one download.
const inFlight = new Map();

/**
 * Make sure `name` is available, downloading it on first use. Returns
 * { pathDirs, vars } to merge into the child process environment.
 */
export async function ensureTool(name, onOutput) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  for (const dep of tool.requires || []) await ensureTool(dep, onOutput);
  if (isProvisioned(name)) return getProvisionedEnv(name);
  if (!inFlight.has(name)) {
    inFlight.set(name, provision(name, onOutput).finally(() => inFlight.delete(name)));
  }
  await inFlight.get(name);
  return getProvisionedEnv(name);
}

async function provision(name, onOutput) {
  const tool = TOOLS[name];
  const urlSpec = tool.urls[PLATFORM];
  if (!urlSpec) {
    throw new Error(`${tool.label} can't be auto-installed on ${PLATFORM}. Please install it manually.`);
  }
  const url = typeof urlSpec === 'function' ? await urlSpec() : urlSpec;
  const toolDir = join(PROVISION_DIR, name);
  mkdirSync(toolDir, { recursive: true });

  onOutput?.(`\n${tool.icon} ${tool.label} not found — downloading it (one-time setup)...\n`);
  let binDir;
  if (tool.install) {
    binDir = await tool.install({ url, toolDir, tool, onOutput });
  } else {
    const archiveExt = tool.archive || archiveExtOf(url);
    const archivePath = join(PROVISION_DIR, `${name}-download${archiveExt}`);
    try {
      await downloadFile(url, archivePath, onOutput);
      onOutput?.(`  Extracting ${tool.label}...\n`);
      await extractArchive(archivePath, toolDir);
    } finally {
      try { unlinkSync(archivePath); } catch {}
    }
    binDir = findBinDir(toolDir, tool.bin);
    if (!binDir) throw new Error(`${tool.label} downloaded, but ${tool.bin} wasn't found inside it.`);
    if (!IS_WIN) makeExecutable(binDir);
  }
  if (tool.setup) await tool.setup({ binDir, onOutput });

  writeFileSync(markerPath(name), JSON.stringify({
    binDir: relative(PROVISION_DIR, binDir), url, provisionedAt: new Date().toISOString(), platform: PLATFORM,
  }));
  onOutput?.(`✅ ${tool.label} ready.\n\n`);
}

function archiveExtOf(url) {
  if (url.endsWith('.tar.gz') || url.endsWith('.tgz')) return '.tar.gz';
  if (url.endsWith('.7z')) return '.7z';
  return '.zip';
}

/** Breadth-first search for the directory holding `binName`. */
function findBinDir(root, binName, maxDepth = 5) {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      if (existsSync(join(dir, binName))) return dir;
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.')) next.push(join(dir, e.name));
        }
      } catch {
        // unreadable — skip
      }
    }
    level = next;
  }
  return null;
}

function makeExecutable(binDir) {
  try {
    for (const f of readdirSync(binDir)) chmodSync(join(binDir, f), 0o755);
  } catch {
    // best effort
  }
}

/**
 * Download a file, following redirects, with throttled progress output.
 */
function downloadFile(url, destPath, onOutput) {
  return new Promise((resolve, reject) => {
    const get = (target, redirectsLeft) => {
      const proto = target.startsWith('https') ? https : http;
      proto.get(target, { headers: { 'User-Agent': 'repo-runner' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          return get(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${target}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        let lastPct = -10;
        res.on('data', (chunk) => {
          done += chunk.length;
          if (!total) return;
          const pct = Math.floor((done / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            onOutput?.(`  Downloading... ${pct}% (${(done / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB)\n`);
          }
        });
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url, 10);
  });
}

/** Run a command without blocking the server. Resolves { code, output }. */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let output = '';
    const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });
    proc.on('error', (err) => resolve({ code: -1, output: err.message }));
    proc.on('exit', (code) => resolve({ code, output }));
  });
}

/**
 * Extract zip / 7z / tar.gz. On Windows the built-in bsdtar (System32\tar.exe)
 * handles all three and is far faster than Expand-Archive on big toolchains.
 */
async function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  let r;
  if (IS_WIN) {
    const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(bsdtar)) {
      r = await runAsync(bsdtar, ['-xf', archivePath, '-C', destDir]);
      if (r.code === 0) return;
    }
    if (archivePath.endsWith('.zip')) {
      r = await runAsync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${destDir}'`]);
    }
  } else if (archivePath.endsWith('.zip')) {
    r = await runAsync('unzip', ['-q', '-o', archivePath, '-d', destDir]);
  } else {
    r = await runAsync('tar', ['-xf', archivePath, '-C', destDir]);
  }
  if (r?.code !== 0) throw new Error(`Couldn't extract ${archivePath}: ${(r?.output || '').slice(-300)}`);
}

// ─── Tool-specific setup ───

async function resolvePhpUrl() {
  const tmp = join(PROVISION_DIR, 'php-releases.json');
  mkdirSync(PROVISION_DIR, { recursive: true });
  await downloadFile('https://downloads.php.net/~windows/releases/releases.json', tmp);
  const releases = JSON.parse(readFileSync(tmp, 'utf8'));
  try { unlinkSync(tmp); } catch {}
  const branch = releases[PHP_BRANCH];
  const build = branch?.['nts-vs16-x64'] || branch?.['nts-vs17-x64'];
  if (!build?.zip?.path) throw new Error(`No Windows build listed for PHP ${PHP_BRANCH}`);
  return `https://downloads.php.net/~windows/releases/${build.zip.path}`;
}

/** Create php.ini with the extensions typical apps need, and add Composer. */
async function setupPhp({ binDir, onOutput }) {
  const iniSrc = join(binDir, 'php.ini-development');
  if (existsSync(iniSrc)) {
    let ini = readFileSync(iniSrc, 'utf8');
    ini = ini.replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "ext"');
    for (const ext of ['curl', 'fileinfo', 'gd', 'intl', 'mbstring', 'openssl', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'sqlite3', 'zip', 'sodium']) {
      ini = ini.replace(new RegExp(`^;\\s*extension=${ext}\\s*$`, 'm'), `extension=${ext}`);
    }
    writeFileSync(join(binDir, 'php.ini'), ini);
  }
  onOutput?.('  Adding Composer...\n');
  await downloadFile('https://getcomposer.org/download/latest-stable/composer.phar', join(binDir, 'composer.phar'), onOutput);
  writeFileSync(join(binDir, 'composer.bat'), '@php "%~dp0composer.phar" %*\r\n');
}

/**
 * Install Rust into .runtimes/rust via rustup-init. On Windows without the
 * MSVC build tools, use the GNU toolchain, which ships its own linker.
 */
async function installRust({ url, toolDir, tool, onOutput }) {
  const initPath = join(toolDir, exe('rustup-init'));
  await downloadFile(url, initPath, onOutput);
  if (!IS_WIN) chmodSync(initPath, 0o755);

  const args = ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'stable'];
  if (IS_WIN && !hasMsvcBuildTools()) args.push('--default-host', 'x86_64-pc-windows-gnu');

  onOutput?.('  Installing the stable toolchain (this takes a minute)...\n');
  const r = await runAsync(initPath, args, { env: { ...process.env, ...tool.env() } });
  if (r.code !== 0) throw new Error(`rustup-init failed: ${r.output.slice(-500)}`);
  try { unlinkSync(initPath); } catch {}
  return join(toolDir, 'cargo', 'bin');
}

// ─── .NET SDK ───
// Installed with Microsoft's dotnet-install script; channels install side by
// side in one folder, so a repo needing .NET 9 doesn't disturb one on .NET 8.

const DOTNET_DIR = join(PROVISION_DIR, 'dotnet');

export function dotnetEnv() {
  return { pathDirs: [DOTNET_DIR], vars: { DOTNET_ROOT: DOTNET_DIR, DOTNET_MULTILEVEL_LOOKUP: '0' } };
}

export async function ensureDotnetSdk(channel, onOutput) {
  const marker = join(DOTNET_DIR, `.provisioned-${channel}`);
  if (existsSync(marker)) return dotnetEnv();
  mkdirSync(DOTNET_DIR, { recursive: true });
  onOutput?.(`\n🟣 .NET ${channel} SDK not found — downloading it (one-time setup)...\n`);
  const script = join(PROVISION_DIR, IS_WIN ? 'dotnet-install.ps1' : 'dotnet-install.sh');
  await downloadFile(`https://dot.net/v1/${IS_WIN ? 'dotnet-install.ps1' : 'dotnet-install.sh'}`, script);
  const r = IS_WIN
    ? await runAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Channel', channel, '-InstallDir', DOTNET_DIR, '-NoPath'])
    : await runAsync('bash', [script, '--channel', channel, '--install-dir', DOTNET_DIR, '--no-path']);
  if (r.code !== 0) throw new Error(`Installing the .NET ${channel} SDK failed: ${r.output.slice(-400)}`);
  writeFileSync(marker, new Date().toISOString());
  onOutput?.(`✅ .NET ${channel} SDK ready.\n\n`);
  return dotnetEnv();
}

function hasMsvcBuildTools() {
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return false;
  try {
    const out = execSync(`"${vswhere}" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`, { stdio: 'pipe' });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}
