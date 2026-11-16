import { normalizePath, requestUrl, type DataAdapter, type PluginManifest } from "obsidian";

const API_URL = "https://api.github.com/repos/Camokas/Obsidian-Gantt-Notes/releases/latest";
const FILES = ["main.js", "manifest.json", "styles.css"] as const;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface PluginUpdate {
  version: string;
  pageUrl: string;
  assets: Record<(typeof FILES)[number], string>;
}

export const normalizeVersion = (version: string) => version.trim().replace(/^v/i, "").split("+")[0];

export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.-]/);
  const pb = normalizeVersion(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? "0";
    const bv = pb[i] ?? "0";
    const an = /^\d+$/.test(av) ? Number(av) : NaN;
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN;
    const cmp = Number.isNaN(an) || Number.isNaN(bn) ? av.localeCompare(bv) : an - bn;
    if (cmp !== 0) return cmp > 0 ? 1 : -1;
  }
  return 0;
}

export async function findUpdate(currentVersion: string): Promise<PluginUpdate | null> {
  const response = await requestUrl({
    url: API_URL,
    headers: { Accept: "application/vnd.github+json" },
  });
  const release = response.json as GithubRelease;
  if (!release || release.draft || release.prerelease) throw new Error("GitHub returned an invalid release");
  const version = normalizeVersion(release.tag_name);
  if (compareVersions(version, currentVersion) <= 0) return null;

  const urls = Object.fromEntries(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
  for (const file of FILES) {
    if (!urls[file]) throw new Error(`Release ${version} has no ${file}`);
  }
  return { version, pageUrl: release.html_url, assets: urls as PluginUpdate["assets"] };
}

async function restore(adapter: DataAdapter, backups: Map<string, string | null>) {
  for (const [path, content] of backups) {
    if (content === null) {
      if (await adapter.exists(path)) await adapter.remove(path);
    } else {
      await adapter.write(path, content);
    }
  }
}

/** Download, validate, then install a complete release with rollback on error. */
export async function installUpdate(
  adapter: DataAdapter,
  configDir: string,
  manifest: PluginManifest,
  update: PluginUpdate
): Promise<void> {
  const downloaded = new Map<string, string>();
  for (const file of FILES) {
    const response = await requestUrl({ url: update.assets[file], headers: { Accept: "application/octet-stream" } });
    if (!response.text.trim()) throw new Error(`${file} is empty`);
    downloaded.set(file, response.text);
  }

  const nextManifest = JSON.parse(downloaded.get("manifest.json")!) as PluginManifest;
  if (nextManifest.id !== manifest.id) throw new Error("Downloaded plugin ID does not match");
  if (normalizeVersion(nextManifest.version) !== update.version) throw new Error("Downloaded version does not match the release");

  const dir = normalizePath(`${configDir}/plugins/${manifest.id}`);
  const backups = new Map<string, string | null>();
  for (const file of FILES) {
    const path = normalizePath(`${dir}/${file}`);
    backups.set(path, (await adapter.exists(path)) ? await adapter.read(path) : null);
  }

  try {
    for (const file of FILES) await adapter.write(normalizePath(`${dir}/${file}`), downloaded.get(file)!);
  } catch (error) {
    await restore(adapter, backups);
    throw error;
  }
}
