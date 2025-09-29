// /api/config.js
export default function handler(req, res) {
  // Do NOT put secrets here; publishable key is safe to expose.
  const pk = process.env.STRIPE_PUBLISHABLE_KEY || "";
  if (!pk) {
    return res.status(500).json({ error: "Missing STRIPE_PUBLISHABLE_KEY" });
  }
  res.status(200).json({ publishableKey: pk });
}
