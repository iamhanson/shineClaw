/**
 * Node.js install strategy — download portable binary to ~/.shan/runtime/node/
 *
 * Downloads the official Node.js binary distribution for the current platform
 * and extracts it. Uses streaming download with progress reporting.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import type { ProgressEmitter } from '../progress';
import { getRuntimeDir, getRuntimeBinDir, ensureRuntimeRoot } from '../runtime-paths';
import { shouldOptimizeNetwork } from '../../../utils/uv-env';
import { logger } from '../../../utils/logger';

const NODE_VERSION = '22.16.0';
const BASE_URL_OFFICIAL = `https://nodejs.org/dist/v${NODE_VERSION}`;
const BASE_URL_MIRROR = `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}`;

async function getNodeBaseUrl(): Promise<string> {
  const useMirror = await shouldOptimizeNetwork();
  return useMirror ? BASE_URL_MIRROR : BASE_URL_OFFICIAL;
}

interface NodeTarget {
  filename: string;
  extractDir: string;
}

function getNodeTarget(): NodeTarget {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    const archLabel = arch === 'arm64' ? 'arm64' : 'x64';
    return {
      filename: `node-v${NODE_VERSION}-darwin-${archLabel}.tar.gz`,
      extractDir: `node-v${NODE_VERSION}-darwin-${archLabel}`,
    };
  }
  if (platform === 'win32') {
    const archLabel = arch === 'arm64' ? 'arm64' : 'x64';
    return {
      filename: `node-v${NODE_VERSION}-win-${archLabel}.zip`,
      extractDir: `node-v${NODE_VERSION}-win-${archLabel}`,
    };
  }
  // Linux
  const archLabel = arch === 'arm64' ? 'arm64' : 'x64';
  return {
    filename: `node-v${NODE_VERSION}-linux-${archLabel}.tar.xz`,
    extractDir: `node-v${NODE_VERSION}-linux-${archLabel}`,
  };
}

function followRedirects(url: string): Promise<{ res: any; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects'));
      }
      httpsGet(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) return reject(new Error('Redirect without location'));
          res.resume();
          doGet(location, redirectCount + 1);
        } else if (res.statusCode === 200) {
          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          resolve({ res, totalBytes });
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
        }
      }).on('error', reject);
    };
    doGet(url);
  });
}

export async function installNode(emitter: ProgressEmitter): Promise<void> {
  ensureRuntimeRoot();
  const targetDir = getRuntimeDir('node');
  const tempDir = join(getRuntimeDir('node'), '_temp_extract');

  // Clean up any previous partial install
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const target = getNodeTarget();
  const baseUrl = await getNodeBaseUrl();
  const downloadUrl = `${baseUrl}/${target.filename}`;
  const archivePath = join(tempDir, target.filename);

  const usingMirror = baseUrl === BASE_URL_MIRROR;
  emitter.update(
    'downloading',
    5,
    `Downloading Node.js v${NODE_VERSION}${usingMirror ? ' (CN mirror)' : ''}...`
  );
  logger.info(`[node-install] Downloading from ${downloadUrl} (mirror=${usingMirror})`);

  // Download
  const { res, totalBytes } = await followRedirects(downloadUrl);
  await new Promise<void>((resolve, reject) => {
    let downloadedBytes = 0;
    const fileStream = createWriteStream(archivePath);

    res.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      const percent = totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 60) + 5 : 30;
      emitter.update(
        'downloading',
        percent,
        `${(downloadedBytes / 1024 / 1024).toFixed(1)} MB downloaded`,
        {
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes,
        }
      );
    });

    res.pipe(fileStream);
    fileStream.on('finish', () => resolve());
    fileStream.on('error', reject);
    res.on('error', reject);
  });

  // Extract
  emitter.update('extracting', 70, 'Extracting Node.js...');
  await extractArchive(archivePath, tempDir, target);

  // Move bin to final location
  emitter.update('installing', 85, 'Installing Node.js binary...');
  const extractedDir = join(tempDir, target.extractDir);
  const binDir = getRuntimeBinDir('node');

  if (process.platform === 'win32') {
    // Windows: node.exe is at root of extracted dir
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
    const nodeExe = join(extractedDir, 'node.exe');
    if (existsSync(nodeExe)) {
      renameSync(nodeExe, join(binDir, 'node.exe'));
    }
  } else {
    // Unix: bin/node is inside extracted dir
    const srcBinDir = join(extractedDir, 'bin');
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
    const nodeExe = join(srcBinDir, 'node');
    if (existsSync(nodeExe)) {
      renameSync(nodeExe, join(binDir, 'node'));
      chmodSync(join(binDir, 'node'), 0o755);
    }
  }

  // Verify
  emitter.update('verifying', 95, 'Verifying Node.js...');
  const nodeBin = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(nodeBin)) {
    throw new Error(`Node binary not found at ${nodeBin} after extraction`);
  }

  // Cleanup temp
  rmSync(tempDir, { recursive: true, force: true });
  emitter.done(`Node.js v${NODE_VERSION} installed`);
  logger.info(`[node-install] Installed at ${nodeBin}`);
}

async function extractArchive(
  archivePath: string,
  tempDir: string,
  target: NodeTarget
): Promise<void> {
  const platform = process.platform;

  return new Promise((resolve, reject) => {
    let child;

    if (platform === 'win32') {
      // Use PowerShell to extract zip
      const psCommand = `Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force`;
      child = spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (target.filename.endsWith('.tar.gz')) {
      child = spawn('tar', ['xzf', archivePath, '-C', tempDir], {
        stdio: 'ignore',
      });
    } else if (target.filename.endsWith('.tar.xz')) {
      child = spawn('tar', ['xJf', archivePath, '-C', tempDir], {
        stdio: 'ignore',
      });
    } else {
      return reject(new Error(`Unknown archive format: ${target.filename}`));
    }

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Extraction failed with code ${code}`));
    });
    child.on('error', reject);
  });
}
