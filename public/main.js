<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Main Page</title>
    <script>
        // On main.html, add this script to handle access token
        window.addEventListener('DOMContentLoaded', function () {
            // Check for token in localStorage
            const token = localStorage.getItem('access_token');
            const urlParams = new URLSearchParams(window.location.search);
            const sessionId = urlParams.get('session_id');

            if (token) {
                // Token exists, allow access
                return;
            } else if (sessionId) {
                // No token, but session_id present (just paid)
                fetch('/api/verify-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.token) {
                        localStorage.setItem('access_token', data.token);
                        // Remove session_id from URL
                        window.location.replace('/main.html');
                    } else {
                        alert('Payment verification failed.');
                        window.location.replace('/index.html');
                    }
                })
                .catch(() => {
                    alert('Payment verification error.');
                    window.location.replace('/index.html');
                });
            } else {
                // No token and no session_id, redirect to welcome
                window.location.replace('/index.html');
            }
        });
    </script>
</head>
<body>
    <h1>Welcome to the Main Page</h1>
    <!-- Main content of the page -->
</body>
</html>
