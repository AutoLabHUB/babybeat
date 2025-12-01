// welcome.js
// Handles Stripe checkout from index.html

async function getStripe() {
  const r = await fetch("/api/config");
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error("CONFIG returned non-JSON:", r.status, text);
    throw new Error("Config route not returning JSON");
  }
  if (!r.ok) throw new Error(data.error || "Failed to load Stripe config");
  if (!data.publishableKey) throw new Error("Missing STRIPE_PUBLISHABLE_KEY");
  return Stripe(data.publishableKey);
}

window.startCheckout = async function () {
  try {
    const stripe = await getStripe();
    const r = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({})
    });

    const bodyText = await r.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      console.error("CHECKOUT returned non-JSON:", r.status, bodyText);
      alert("Server returned an HTML error page. See console.");
      return;
    }

    if (!r.ok) {
      console.error("Checkout error:", data);
      alert(data.error || "Server error creating session");
      return;
    }

    await stripe.redirectToCheckout({ sessionId: data.id });
  } catch (e) {
    console.error(e);
    alert(e.message || "Checkout config error");
  }
};

// Wire up buttons on landing page
window.addEventListener("DOMContentLoaded", () => {
  const triggers = document.querySelectorAll("#checkout-button, [data-checkout]");
  triggers.forEach(el => el.addEventListener("click", (e) => {
    e.preventDefault();
    window.startCheckout();
  }));
});
