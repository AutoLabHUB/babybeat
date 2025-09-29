// /api/create-checkout-session.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      // Optional: customer email collection
      // customer_creation: 'always'
    });

    return res.status(200).json({ id: session.id });
  } catch (err) {
    console.error('[checkout] create failed:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
