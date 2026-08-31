const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const filesToCopy = [
  "index.html",
  "style.css",
  "script.js",
  "firebase.js",
  "auth-fixes.js",
];

fs.mkdirSync(publicDir, { recursive: true });

for (const fileName of filesToCopy) {
  const sourcePath = path.join(rootDir, fileName);
  const targetPath = path.join(publicDir, fileName);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

console.log(`Public assets copied to ${publicDir}`);
