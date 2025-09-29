// /api/create-checkout-session.js
import Stripe from "stripe";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const missing = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    return res
      .status(500)
      .json({ error: `Missing env var(s): ${missing.join(", ")}` });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
    });

    return res.status(200).json({ id: session.id });
  } catch (err) {
    // Surface enough detail to debug (without secrets)
    const code = err?.code || err?.type || "server_error";
    const message = err?.message || "Internal Server Error";
    console.error("[checkout] failed:", code, message);
    const status = code === "resource_missing" || code === "invalid_request_error" ? 400 : 500;
    return res.status(status).json({ error: message, code });
  }
}
