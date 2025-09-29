// /api/verify-admin.js
export default async function handler(req, res) {
  try {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
    if (!match) return res.status(401).json({ ok: false });

    const token = match[1];
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return res.status(401).json({ ok: false });

    const { createHmac } = await import('node:crypto');
    const secret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
    const expectedSig = createHmac('sha256', secret).update(payload).digest('base64url');
    if (sig !== expectedSig) return res.status(401).json({ ok: false });

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // Optional: expire older sessions (e.g., > 24h)
    if (Date.now() - data.ts > 1000 * 60 * 60 * 24) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    return res.status(200).json({ ok: true, role: 'admin' });
  } catch {
    return res.status(401).json({ ok: false });
  }
}
