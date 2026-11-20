import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repo = "razzant/claudexor";
const releases = `https://github.com/${repo}/releases`;

// The source HTML works on its own. Enhance just its two Mac links before Pages
// uploads it, never from the visitor's browser and never from npm metadata.
export async function resolveMacLinks(html, request = fetch) {
  const picker = /data-mac-installer\s+href="([^"]+)"\s*>\s*Choose the Claudexor \.dmg(?=<\/a)/g;
  const links = [...html.matchAll(picker)];
  if (links.length !== 2 || links.some((link) => link[1] !== `${releases}/latest`)) {
    throw new Error("Expected two ordinary Mac release-picker links");
  }
  try {
    const response = await request(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const release = await response.json();
    const tag = release.tag_name;
    const dmgs = release.assets.filter((a) => a.name.toLowerCase().endsWith(".dmg"));
    const asset = dmgs[0];
    if (
      release.draft !== false ||
      release.prerelease !== false ||
      !/^v\d+\.\d+\.\d+$/.test(tag) ||
      release.html_url !== `${releases}/tag/${tag}` ||
      dmgs.length !== 1 ||
      asset.state !== "uploaded" ||
      asset.name !== `Claudexor-${tag.slice(1)}.dmg` ||
      asset.browser_download_url !== `${releases}/download/${tag}/${asset.name}`
    ) {
      throw new Error("No unique published Claudexor DMG for this stable release");
    }
    return html.replaceAll(
      picker,
      `data-mac-installer href="${asset.browser_download_url}">Download for macOS`,
    );
  } catch (error) {
    console.warn(`Mac installer: keeping the release picker (${error.message})`);
    return html;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  writeFileSync(file, await resolveMacLinks(readFileSync(file, "utf8")));
}
