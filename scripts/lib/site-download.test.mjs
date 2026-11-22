import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveMacLinks } from "../site-download.mjs";

const source = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
const releases = "https://github.com/razzant/claudexor/releases";
const api = "https://api.github.com/repos/razzant/claudexor/releases/latest";
function published(version) {
  const tag = `v${version}`;
  const name = `Claudexor-${version}.dmg`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${releases}/tag/${tag}`,
    assets: [
      { name, state: "uploaded", browser_download_url: `${releases}/download/${tag}/${name}` },
    ],
  };
}

it.each(["6.2.0", "6.3.0"])(
  "uses the published %s DMG in both sections without asking npm",
  async (version) => {
    const release = published(version);
    const calls = [];
    const html = await resolveMacLinks(source, async (url) => {
      calls.push(url);
      return Response.json(release);
    });
    expect(calls).toEqual([api]);
    for (const id of ["top", "install"]) {
      const section = html.split(`id="${id}"`)[1].split("</section>")[0];
      expect(section).toContain(
        `href="${release.assets[0].browser_download_url}">Download for macOS`,
      );
    }
  },
);

it("retains labelled ordinary anchors if the lookup or its evidence is unusable", async () => {
  const r = published("6.3.0");
  const asset = r.assets[0];
  for (const response of [
    () => {
      throw new Error("offline");
    },
    () => new Response(null, { status: 403 }),
    () => new Response("not JSON"),
    ...[
      null,
      { ...r, assets: [] },
      { ...r, prerelease: true },
      { ...r, draft: true },
      { ...r, assets: [asset, { ...asset, name: "another.dmg" }] },
      { ...r, assets: [{ ...asset, state: "new" }] },
      { ...r, assets: [{ ...asset, browser_download_url: "https://example.org/Claudexor.dmg" }] },
      { ...r, html_url: "https://github.com/other/claudexor/releases/tag/v6.3.0" },
    ].map((data) => () => Response.json(data)),
  ]) {
    expect(await resolveMacLinks(source, response)).toBe(source);
  }
  expect(
    source.match(
      /data-mac-installer\s+href="https:\/\/github\.com\/razzant\/claudexor\/releases\/latest"\s*>\s*Choose the Claudexor \.dmg/g,
    ),
  ).toHaveLength(2);
});
