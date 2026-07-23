import { describe, expect, it } from "vitest";
import {
  ABOUT_AUTHOR,
  ABOUT_LICENSE,
  ABOUT_LINKS,
  ABOUT_PRODUCT_NAME,
  aboutJson,
  renderAbout,
} from "./about-command.js";
import { CLI_COMMANDS, helpJson, renderHelp } from "./command-registry.js";

describe("claudexor about (D-11)", () => {
  it("text output carries product name, version, author, license, and every link", () => {
    const text = renderAbout("3.1.0");
    expect(text).toContain(ABOUT_PRODUCT_NAME);
    expect(text).toContain("v3.1.0");
    expect(text).toContain(ABOUT_AUTHOR);
    expect(text).toContain(ABOUT_LICENSE);
    expect(text).toContain(ABOUT_LINKS.repository);
    expect(text).toContain(ABOUT_LINKS.telegram);
    expect(text).toContain(ABOUT_LINKS.x);
  });

  it("--json envelope is the stable machine identity contract", () => {
    const j = aboutJson("3.1.0");
    expect(j).toEqual({
      ok: true,
      name: "Claudexor",
      version: "3.1.0",
      author: "Anton Razzhigaev",
      license: "MIT",
      links: {
        telegram: "https://t.me/abstractDL",
        x: "https://x.com/AbstractDL",
        repository: "https://github.com/razzant/claudexor",
      },
    });
  });

  it("is registered in the command surface so help/help --json advertise it", () => {
    expect(CLI_COMMANDS.map((c) => c.id)).toContain("about");
    expect(renderHelp("0.0.0-test")).toContain("claudexor about");
    expect(helpJson("0.0.0-test").commands.map((c) => c.id)).toContain("about");
  });
});
