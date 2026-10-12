const packageJson = require("../package.json");

const build = JSON.parse(JSON.stringify(packageJson.build));

build.productName = "PaperBridge";
build.artifactName = "PaperBridge-Setup.${ext}";
build.asarUnpack = (build.asarUnpack || []).filter((pattern) => !String(pattern).includes("node_modules/dugite/git"));
build.files = [
  ...(build.files || []),
  "!node_modules/dugite/git/**/*"
];

module.exports = build;
