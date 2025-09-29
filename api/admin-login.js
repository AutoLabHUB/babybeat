// /api/admin-login.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password } = req.body || {};
    const expected = process.env.ADMIN_PASSWORD;

    if (!expected) {
      return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
    }
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Missing password' });
    }

    // Constant-time compare
    const { timingSafeEqual, createHmac, randomBytes } = await import('node:crypto');
    const enc = (s) => Buffer.from(String(s));
    const a = enc(password);
    const b = enc(expected);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Make a minimal signed token (HMAC). You can replace with JWT if you prefer.
    const secret = process.env.SESSION_SECRET || expected;
    const uid = randomBytes(8).toString('hex');
    const ts = Date.now();
    const payload = Buffer.from(JSON.stringify({ uid, ts, role: 'admin' })).toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    const token = `${payload}.${sig}`;

    // 12 hours
    const maxAge = 60 * 60 * 12;
    const cookie = [
      `admin_session=${token}`,
      `HttpOnly`,
      `Secure`,
      `SameSite=Lax`,
      `Path=/`,
      `Max-Age=${maxAge}`
    ].join('; ');

    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
