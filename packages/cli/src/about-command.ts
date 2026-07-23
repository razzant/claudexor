/**
 * `claudexor about` — product identity, version, author, license, and the
 * owner's canonical links (D-11). Text is the default; `--json` emits a small
 * stable envelope agents can parse. The Swift About panel (Ф3) and the packed
 * npm-manifest assertion (Ф5) consume the SAME facts declared here.
 */

/** The single source of the product's non-version identity facts. */
export const ABOUT_PRODUCT_NAME = "Claudexor";
export const ABOUT_AUTHOR = "Anton Razzhigaev";
export const ABOUT_LICENSE = "MIT";
export const ABOUT_LINKS = {
  telegram: "https://t.me/abstractDL",
  x: "https://x.com/AbstractDL",
  repository: "https://github.com/razzant/claudexor",
} as const;

export interface AboutJson {
  readonly ok: true;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly license: string;
  readonly links: {
    readonly telegram: string;
    readonly x: string;
    readonly repository: string;
  };
}

/** Machine-readable identity envelope (`claudexor about --json`). */
export function aboutJson(version: string): AboutJson {
  return {
    ok: true,
    name: ABOUT_PRODUCT_NAME,
    version,
    author: ABOUT_AUTHOR,
    license: ABOUT_LICENSE,
    links: { ...ABOUT_LINKS },
  };
}

/** Human-readable `claudexor about` text. */
export function renderAbout(version: string): string {
  return [
    `${ABOUT_PRODUCT_NAME} v${version}`,
    "harness-agnostic AI coding control plane",
    "",
    `Author:     ${ABOUT_AUTHOR}`,
    `License:    ${ABOUT_LICENSE}`,
    `Repository: ${ABOUT_LINKS.repository}`,
    `Telegram:   ${ABOUT_LINKS.telegram}`,
    `X:          ${ABOUT_LINKS.x}`,
  ].join("\n");
}
