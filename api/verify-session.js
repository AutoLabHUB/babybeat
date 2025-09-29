const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

let ISSUED_TOKENS = new Set(); // In-memory for demo

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      const token = crypto.randomBytes(32).toString('hex');
      ISSUED_TOKENS.add(token);
      return res.json({ token });
    } else {
      return res.status(403).json({ error: 'Payment not completed' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid session_id' });
  }
};
