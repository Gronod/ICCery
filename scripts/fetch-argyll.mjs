#!/usr/bin/env node

/**
 * scripts/fetch-argyll.mjs
 *
 * Downloads, extracts, and stages ArgyllCMS release binaries for the current
 * or requested platform from https://github.com/Gronod/argyllcms/releases.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TAURI_ARGYLL_DIR = path.join(ROOT_DIR, 'src-tauri', 'argyll');

const PLATFORMS = {
  'linux-x86_64': {
    assetSuffix: '_linux_x86_64_bin.tgz',
    markerBinary: 'instlist',
    destDir: path.join(TAURI_ARGYLL_DIR, 'linux-x86_64'),
    isWindows: false,
  },
  'windows-x86_64': {
    assetSuffix: '_win64_exe.zip',
    markerBinary: 'instlist.exe',
    destDir: path.join(TAURI_ARGYLL_DIR, 'windows-x86_64'),
    isWindows: true,
  },
  'macos-x86_64': {
    assetSuffix: '_macOS_x86_64_bin.tgz',
    markerBinary: 'instlist',
    destDir: path.join(TAURI_ARGYLL_DIR, 'macos-x86_64'),
    isWindows: false,
  },
  'macos-aarch64': {
    assetSuffix: '_macOS_arm64_bin.tgz',
    markerBinary: 'instlist',
    destDir: path.join(TAURI_ARGYLL_DIR, 'macos-aarch64'),
    isWindows: false,
  },
  'macos-universal': {
    assetSuffix: '_macOS_universal_bin.tgz',
    markerBinary: 'instlist',
    destDir: path.join(TAURI_ARGYLL_DIR, 'macos-universal'),
    isWindows: false,
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let force = false;
  let platform = null;
  let server = process.env.ARGYLL_SERVER_URL || process.env.GITEA_SERVER_URL || null;
  let repo = process.env.ARGYLL_REPO || 'gronod/argyllcms';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--platform' && i + 1 < args.length) {
      platform = args[++i];
    } else if (args[i].startsWith('--platform=')) {
      platform = args[i].split('=')[1];
    } else if (args[i] === '--server' && i + 1 < args.length) {
      server = args[++i];
    } else if (args[i].startsWith('--server=')) {
      server = args[i].split('=')[1];
    } else if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[++i];
    } else if (args[i].startsWith('--repo=')) {
      repo = args[i].split('=')[1];
    }
  }

  if (!platform) {
    const osPlatform = process.platform;
    const osArch = process.arch;

    if (osPlatform === 'linux' && (osArch === 'x64' || osArch === 'x86_64')) {
      platform = 'linux-x86_64';
    } else if (osPlatform === 'win32' && (osArch === 'x64' || osArch === 'x86_64')) {
      platform = 'windows-x86_64';
    } else if (osPlatform === 'darwin') {
      if (osArch === 'arm64' || osArch === 'aarch64') {
        platform = 'macos-aarch64';
      } else {
        platform = 'macos-x86_64';
      }
    } else {
      console.error(`Unsupported platform/architecture: ${osPlatform}-${osArch}`);
      process.exit(1);
    }
  }

  if (!PLATFORMS[platform]) {
    console.error(`Unknown platform '${platform}'. Valid platforms: ${Object.keys(PLATFORMS).join(', ')}`);
    process.exit(1);
  }

  return { force, platform, server, repo };
}

async function getReleaseData(server, repo, tag, token) {
  const isGitHub = !server || server.includes('github.com');
  const cleanServer = (server || 'https://api.github.com').replace(/\/+$/, '');

  let url;
  if (isGitHub) {
    const apiBase = server && !server.includes('api.github.com') ? 'https://api.github.com' : cleanServer;
    const baseUrl = `${apiBase}/repos/${repo}/releases`;
    url = tag ? `${baseUrl}/tags/${encodeURIComponent(tag)}` : `${baseUrl}/latest`;
  } else {
    // Gitea / Forgejo releases API
    const baseUrl = `${cleanServer}/api/v1/repos/${repo}/releases`;
    url = tag ? `${baseUrl}/tags/${encodeURIComponent(tag)}` : `${baseUrl}/latest`;
  }

  const headers = {
    'User-Agent': 'ICCery-fetch-argyll',
    Accept: 'application/vnd.github+json, application/json',
  };
  if (token) {
    headers.Authorization = isGitHub ? `Bearer ${token}` : `token ${token}`;
  }

  console.log(`Fetching release info from ${url}...`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch release info: HTTP ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function extractArchive(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  console.log(`Extracting ${path.basename(archivePath)} to ${extractDir}...`);

  if (archivePath.endsWith('.zip')) {
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
      return;
    } catch {
      if (process.platform === 'win32') {
        execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`],
          { stdio: 'inherit' }
        );
        return;
      }
      try {
        execFileSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'inherit' });
        return;
      } catch (err) {
        throw new Error(`Failed to extract zip archive: ${err.message}`);
      }
    }
  } else if (archivePath.endsWith('.tgz') || archivePath.endsWith('.tar.gz')) {
    try {
      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    } catch (err) {
      throw new Error(`Failed to extract tarball: ${err.message}`);
    }
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

function findArchiveRoot(extractDir) {
  const entries = fs.readdirSync(extractDir);
  for (const entry of entries) {
    const fullPath = path.join(extractDir, entry);
    if (fs.statSync(fullPath).isDirectory() && entry.startsWith('Argyll_V')) {
      const binDir = path.join(fullPath, 'bin');
      if (fs.existsSync(binDir) && fs.statSync(binDir).isDirectory()) {
        return fullPath;
      }
    }
  }
  // Check if bin is directly in extractDir
  const directBin = path.join(extractDir, 'bin');
  if (fs.existsSync(directBin) && fs.statSync(directBin).isDirectory()) {
    return extractDir;
  }
  throw new Error(`Could not find Argyll_V* root directory with bin/ inside ${extractDir}`);
}

function copyDirectoryContents(src, dest, chmodExec = false) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(srcPath, destPath, chmodExec);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      if (chmodExec && process.platform !== 'win32') {
        try {
          fs.chmodSync(destPath, 0o755);
        } catch {
          // ignore
        }
      }
    }
  }
}

async function main() {
  const { force, platform, server, repo } = parseArgs();
  const targetConfig = PLATFORMS[platform];
  const markerPath = path.join(targetConfig.destDir, targetConfig.markerBinary);

  if (!force && fs.existsSync(markerPath)) {
    console.log(`ArgyllCMS binaries for ${platform} already present at ${targetConfig.destDir}. (Use --force to re-download)`);
    return;
  }

  const releaseTag = process.env.ARGYLL_RELEASE_TAG || '';
  const token = process.env.GITEA_TOKEN || process.env.GITHUB_TOKEN || '';

  const releaseData = await getReleaseData(server, repo, releaseTag, token);
  console.log(`Selected release tag: ${releaseData.tag_name || releaseTag || 'latest'}`);

  const matchingAsset = (releaseData.assets || []).find((asset) =>
    asset.name.endsWith(targetConfig.assetSuffix)
  );

  if (!matchingAsset) {
    console.error(`Error: No asset matching suffix '${targetConfig.assetSuffix}' found in release.`);
    console.error(`Available assets:`, (releaseData.assets || []).map((a) => a.name));
    process.exit(1);
  }

  console.log(`Found asset: ${matchingAsset.name} (${(matchingAsset.size / (1024 * 1024)).toFixed(2)} MB)`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iccery-argyll-'));
  const archivePath = path.join(tempDir, matchingAsset.name);
  const extractDir = path.join(tempDir, 'extracted');

  try {
    const downloadHeaders = {
      'User-Agent': 'ICCery-fetch-argyll',
      Accept: 'application/octet-stream',
    };
    if (token) {
      const isGitHub = !server || server.includes('github.com');
      downloadHeaders.Authorization = isGitHub ? `Bearer ${token}` : `token ${token}`;
    }

    console.log(`Downloading ${matchingAsset.browser_download_url}...`);
    const res = await fetch(matchingAsset.browser_download_url, {
      headers: downloadHeaders,
    });

    if (!res.ok) {
      throw new Error(`Download failed with status HTTP ${res.status} ${res.statusText}`);
    }

    const fileBuffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, fileBuffer);
    console.log(`Downloaded ${fileBuffer.length} bytes.`);

    extractArchive(archivePath, extractDir);
    const archiveRoot = findArchiveRoot(extractDir);
    console.log(`Discovered archive root: ${archiveRoot}`);

    const srcBin = path.join(archiveRoot, 'bin');
    if (!fs.existsSync(srcBin) || fs.readdirSync(srcBin).length === 0) {
      throw new Error(`bin/ directory is missing or empty in ${archiveRoot}`);
    }

    console.log(`Staging binaries into ${targetConfig.destDir}...`);
    fs.mkdirSync(targetConfig.destDir, { recursive: true });
    copyDirectoryContents(srcBin, targetConfig.destDir, !targetConfig.isWindows);

    // Copy License.txt
    const licenseSrc = path.join(archiveRoot, 'License.txt');
    if (fs.existsSync(licenseSrc)) {
      fs.copyFileSync(licenseSrc, path.join(targetConfig.destDir, 'License.txt'));
      console.log(`Staged License.txt into ${targetConfig.destDir}`);
    }

    // Windows USB driver tree
    if (targetConfig.isWindows) {
      const srcUsb = path.join(archiveRoot, 'usb');
      const destUsb = path.join(TAURI_ARGYLL_DIR, 'usb');
      if (fs.existsSync(srcUsb)) {
        console.log(`Staging Windows USB driver tree into ${destUsb}...`);
        fs.mkdirSync(destUsb, { recursive: true });
        copyDirectoryContents(srcUsb, destUsb, false);

        const usbInstaller = path.join(destUsb, 'ArgyllCMS_install_USB.exe');
        const usbInf = path.join(destUsb, 'ArgyllCMS.inf');
        if (!fs.existsSync(usbInstaller) || !fs.existsSync(usbInf)) {
          throw new Error(`Missing required USB driver files in ${destUsb}`);
        }
      } else {
        throw new Error(`usb/ directory is missing in Windows release archive`);
      }
    }

    // Final verification of marker binary
    if (!fs.existsSync(markerPath)) {
      throw new Error(`Marker binary ${markerPath} not found after staging!`);
    }

    console.log(`\nSuccessfully staged ArgyllCMS binaries for ${platform}!`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err.message}`);
  process.exit(1);
});
