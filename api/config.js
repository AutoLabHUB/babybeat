// /api/config.js
export default function handler(req, res) {
  res.status(200).json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || ""
  });
}
