# Minimal Vercel Project (no vercel.json)

This layout avoids the legacy runtime error entirely.

## Files
- `public/index.html` — UI shell (imports `/api/core?token=...`)
- `public/babybeat-core.js` — core logic (can be minified later)
- `api/core.js` — serverless function that serves the core after checking `CORE_TOKEN`

## Deploy
1. Push to GitHub.
2. In Vercel:
   - Create New Project → Import repo
   - Framework preset: **Other**
   - Build Command: *(leave empty)*
   - Output Directory: **public** (default)
3. Add env var: `CORE_TOKEN=DEV_TOKEN` (or your secret).
4. Visit the site; the shell loads `/api/core?token=DEV_TOKEN`.

If you still see errors, ensure there is **no** `vercel.json` or `now.json` in the repo or in previous commits/settings.
