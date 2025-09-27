// welcome.js - Handles Stripe checkout for the welcome page

// Replace with your actual Stripe publishable key
const stripe = Stripe('pk_test_YOUR_PUBLISHABLE_KEY');

const checkoutButton = document.getElementById('checkout-button');

checkoutButton.addEventListener('click', function () {
    // Create a checkout session on the server
    fetch('/create-checkout-session', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    })
    .then(function (response) {
        return response.json();
    })
    .then(function (session) {
        if (!session.id) throw new Error('No session ID returned');
        return stripe.redirectToCheckout({ sessionId: session.id });
    })
    .then(function (result) {
        if (result.error) {
            alert(result.error.message);
        }
    })
    .catch(function (error) {
        alert('Payment error: ' + error.message);
    });
});
