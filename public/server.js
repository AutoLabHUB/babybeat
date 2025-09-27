const express = require('express');
const app = express();
const stripe = require('stripe')('sk_test_YOUR_SECRET_KEY');
const crypto = require('crypto');
const cors = require('cors');
app.use(cors());
app.use(express.json());

const YOUR_DOMAIN = 'http://localhost:3000';
const ISSUED_TOKENS = new Set(); // In-memory for demo; use DB in production

app.post('/create-checkout-session', async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'BabyBeat Lifetime Access',
          },
          unit_amount: 999,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${YOUR_DOMAIN}/main.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${YOUR_DOMAIN}/index.html`,
  });
  res.json({ id: session.id });
});

// New endpoint: verify Stripe session and issue token
app.post('/verify-session', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      // Issue a simple token (use JWT in production)
      const token = crypto.randomBytes(32).toString('hex');
      ISSUED_TOKENS.add(token);
      return res.json({ token });
    } else {
      return res.status(403).json({ error: 'Payment not completed' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid session_id' });
  }
});

// Example protected endpoint
app.get('/protected', (req, res) => {
  const token = req.headers['authorization'];
  if (ISSUED_TOKENS.has(token)) {
    return res.json({ message: 'Access granted' });
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
});

app.listen(3000, () => console.log('Running on port 3000'));
