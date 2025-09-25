// api/core.js — Vercel Serverless Function (CommonJS). No vercel.json required.
// It serves the core JS only if the token matches the CORE_TOKEN env var.
const fs = require("fs");
const path = require("path");

module.exports = (req, res) => {
  const { token } = req.query || {};
  const valid = process.env.CORE_TOKEN;
  if (!valid || token !== valid) {
    return res.status(403).send("Forbidden");
  }
  const filePath = path.join(process.cwd(), "public", "babybeat-core.js");
  if (!fs.existsSync(filePath)) return res.status(404).send("Core not found");

  const js = fs.readFileSync(filePath, "utf8");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(js);
};
