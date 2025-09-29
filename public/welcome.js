// welcome.js
async function getStripe() {
  const r = await fetch('/api/config');
  const { publishableKey } = await r.json();
  if (!publishableKey) throw new Error('Missing STRIPE_PUBLISHABLE_KEY');
  return Stripe(publishableKey);
}

// Expose a helper the landing page can call
window.startCheckout = async function () {
  try {
    const stripe = await getStripe();
    const res = await fetch('/api/create-checkout-session', { method: 'POST' });
    if (!res.ok) { console.error(await res.text()); alert('Server error creating session'); return; }
    const { id } = await res.json();
    await stripe.redirectToCheckout({ sessionId: id });
  } catch (e) {
    console.error(e);
    alert('Checkout config error. See console for details.');
  }
};

