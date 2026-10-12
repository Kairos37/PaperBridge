import assert from "node:assert/strict";
import test from "node:test";
import { graphicsCommands, graphicsSearchPaths, resolveGraphicPath } from "../public/latex-graphics.js";

const files = [
  "figures/plot.v2.PDF", "figures/panel one.png", "figures/diagram.svg",
  "chapters/images/local.jpg", "chapters/nearby.png", "other/plot.v2.pdf"
].map((path) => ({ type: "file", path }));

test("graphics extraction accepts whitespace, multiline options, starred commands and nested paths", () => {
  const tex = String.raw`\includegraphics* [width={0.5\textwidth}, trim={0 0 0 0}]
    {\detokenize{figures/panel one.png}}
    \includegraphics
      [width=\linewidth] % Layout note
      {figures/plot.v2.PDF}
    \includesvg [width=\linewidth] {figures/diagram}`;
  const commands = graphicsCommands(tex);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map(({ value, command }) => resolveGraphicPath(value, { files, command })), [
    "figures/panel one.png", "figures/plot.v2.PDF", "figures/diagram.svg"
  ]);
});

test("graphics extraction ignores commented and escaped commands", () => {
  const commands = graphicsCommands(String.raw`% \includegraphics{hidden.png}
    \includegraphics{visible.png} % \includegraphics{hidden-too.png}
    \\includegraphics{not-a-command.png}`);
  assert.deepEqual(commands.map((item) => item.value), ["visible.png"]);
});

test("graphics paths use the latest declaration and preserve inherited paths when absent", () => {
  assert.deepEqual(graphicsSearchPaths(String.raw`\graphicspath{{old/}}
    \graphicspath { {figures/} {chapters/images/} }
    % \graphicspath{{ignored/}}`), ["figures/", "chapters/images/"]);
  assert.deepEqual(graphicsSearchPaths("A chapter.", ["figures/"]), ["figures/"]);
});

test("image resolution honors graphicspath and missing extensions without confusing same-named files", () => {
  assert.equal(resolveGraphicPath("plot.v2", { files, searchPaths: ["figures/"] }), "figures/plot.v2.PDF");
  assert.equal(resolveGraphicPath("plot.v2", { files, searchPaths: ["other/"] }), "other/plot.v2.pdf");
  assert.equal(resolveGraphicPath("plot.v2", { files }), "plot.v2");
});

test("image resolution supports source-relative and normalized paths", () => {
  assert.equal(resolveGraphicPath("images/local", { files, sourceFile: "chapters/intro.tex" }), "chapters/images/local.jpg");
  assert.equal(resolveGraphicPath("nearby", { files, sourceFile: "chapters/intro.tex" }), "chapters/nearby.png");
  assert.equal(resolveGraphicPath("../figures/diagram", { files, sourceFile: "chapters/intro.tex" }), "figures/diagram.svg");
  assert.equal(resolveGraphicPath("./figures/diagram.svg", { files }), "figures/diagram.svg");
});

test("image resolution prefers the literal path to fallback directories", () => {
  const candidates = [...files, { type: "file", path: "plot.v2.pdf" }];
  assert.equal(resolveGraphicPath("plot.v2.pdf", { files: candidates, searchPaths: ["other/"] }), "plot.v2.pdf");
  assert.equal(resolveGraphicPath(String.raw`"figures/panel one.png"`, { files }), "figures/panel one.png");
});
