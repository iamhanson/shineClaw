/**
 * Git install strategy — platform-specific portable git download.
 *
 * - macOS: Trigger xcode-select --install (system prompt)
 * - Windows: Download PortableGit from git-for-windows releases
 * - Linux: Provide manual hint (package managers vary too much)
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import type { ProgressEmitter } from '../progress';
import { getRuntimeDir, getRuntimeBinDir, ensureRuntimeRoot } from '../runtime-paths';
import { shouldOptimizeNetwork } from '../../../utils/uv-env';
import { logger } from '../../../utils/logger';

const GIT_VERSION = '2.47.1';
const GIT_WINDOWS_BASE_URL_OFFICIAL = 'https://github.com/git-for-windows/git/releases/download';
const GIT_WINDOWS_BASE_URL_MIRROR = 'https://registry.npmmirror.com/-/binary/git-for-windows';

async function getGitWindowsDownloadUrl(): Promise<{ url: string; mirror: boolean }> {
  const useMirror = await shouldOptimizeNetwork();
  const arch = process.arch === 'x64' ? '64' : '32';
  const filename = `PortableGit-${GIT_VERSION}-${arch}-bit.7z.exe`;

  if (useMirror) {
    return {
      url: `${GIT_WINDOWS_BASE_URL_MIRROR}/v${GIT_VERSION}.windows.1/${filename}`,
      mirror: true,
    };
  }
  return {
    url: `${GIT_WINDOWS_BASE_URL_OFFICIAL}/v${GIT_VERSION}.windows.1/${filename}`,
    mirror: false,
  };
}

/**
 * macOS: Trigger xcode-select --install. This opens a system dialog; we poll
 * until git becomes available.
 */
async function installGitMac(emitter: ProgressEmitter): Promise<void> {
  emitter.update('installing', 10, 'Triggering Xcode Command Line Tools installer...');

  return new Promise((resolve, reject) => {
    const child = spawn('xcode-select', ['--install'], {
      stdio: 'ignore',
      windowsHide: true,
    });

    child.on('close', (code) => {
      if (code === 0 || code === 1) {
        // code 1 means already installed or dialog shown
        emitter.update('installing', 50, 'Waiting for Xcode CLT installation...');
        // Poll for git availability
        const pollInterval = setInterval(async () => {
          const check = spawn('git', ['--version'], { stdio: 'ignore', windowsHide: true });
          check.on('close', (gitCode) => {
            if (gitCode === 0) {
              clearInterval(pollInterval);
              emitter.done('Git installed via Xcode Command Line Tools');
              resolve();
            }
          });
        }, 2000);

        // Timeout after 5 minutes
        setTimeout(
          () => {
            clearInterval(pollInterval);
            reject(new Error('Xcode CLT installation timed out'));
          },
          5 * 60 * 1000
        );
      } else {
        reject(new Error(`xcode-select --install failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Windows: Download PortableGit zip and extract to ~/.shan/runtime/git/
 */
async function installGitWindows(emitter: ProgressEmitter): Promise<void> {
  ensureRuntimeRoot();
  const targetDir = getRuntimeDir('git');
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const arch = process.arch === 'x64' ? '64' : '32';
  const filename = `PortableGit-${GIT_VERSION}-${arch}-bit.7z.exe`;
  const { url: downloadUrl, mirror } = await getGitWindowsDownloadUrl();

  emitter.update('downloading', 5, `Downloading ${filename}${mirror ? ' (CN mirror)' : ''}...`);
  logger.info(`[git-install] Downloading from ${downloadUrl} (mirror=${mirror})`);

  return new Promise((resolve, reject) => {
    httpsGet(downloadUrl, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          return reject(new Error('Redirect without location header'));
        }
        httpsGet(redirectUrl, handleDownload).on('error', reject);
      } else {
        handleDownload(res);
      }
    }).on('error', reject);

    function handleDownload(res: any) {
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      const archivePath = join(targetDir, filename);
      const fileStream = createWriteStream(archivePath);

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const percent = totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 70) + 5 : 50;
        emitter.update(
          'downloading',
          percent,
          `Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB`,
          {
            bytesDownloaded: downloadedBytes,
            bytesTotal: totalBytes,
          }
        );
      });

      res.pipe(fileStream);

      fileStream.on('finish', async () => {
        emitter.update('extracting', 75, 'Extracting PortableGit...');
        try {
          // PortableGit .7z.exe is self-extracting; run it with -y -o flags
          const extractChild = spawn(archivePath, ['-y', `-o${targetDir}`], {
            stdio: 'ignore',
            windowsHide: true,
          });

          extractChild.on('close', (code) => {
            if (code === 0) {
              emitter.update('verifying', 95, 'Verifying git installation...');
              const gitExe = join(getRuntimeBinDir('git'), 'git.exe');
              if (existsSync(gitExe)) {
                emitter.done('Git installed successfully');
                resolve();
              } else {
                reject(new Error('git.exe not found after extraction'));
              }
            } else {
              reject(new Error(`PortableGit extraction failed with code ${code}`));
            }
          });

          extractChild.on('error', reject);
        } catch (error) {
          reject(error);
        }
      });

      fileStream.on('error', reject);
    }
  });
}

/**
 * Linux: No auto-install (package managers vary). Emitter reports manual hint.
 */
async function installGitLinux(emitter: ProgressEmitter): Promise<void> {
  emitter.error('Auto-install not supported on Linux. Please run: sudo apt install git');
  throw new Error('Manual installation required on Linux');
}

export async function installGit(emitter: ProgressEmitter): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    return installGitMac(emitter);
  } else if (platform === 'win32') {
    return installGitWindows(emitter);
  } else {
    return installGitLinux(emitter);
  }
}
