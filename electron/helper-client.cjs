module.exports = require(
  process.platform === "win32"
    ? "./helper-client-windows.cjs"
    : "./helper-client-mac.cjs",
);
