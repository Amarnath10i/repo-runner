// Vercel function: a read-only GitHub API proxy the UI falls back to when a
// visitor's own 60-requests/hour allowance runs out. With GITHUB_TOKEN set in
// the Vercel project it gets that token's 5,000/hour, shared by all visitors.
//
// Only the endpoints the UI needs are forwarded — this isn't an open proxy.

const ALLOWED = [
  /^repos\/[\w.-]+\/[\w.-]+$/,                          // repo info (default branch)
  /^repos\/[\w.-]+\/[\w.-]+\/git\/trees\/[\w.\-/%]+$/,  // file list
  /^repos\/[\w.-]+\/[\w.-]+\/git\/blobs\/[0-9a-f]{40}$/, // file contents (fallback)
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ message: 'Only GET is supported.' });
    return;
  }
  const path = String(req.query.path || '').replace(/^\/+/, '');
  if (!ALLOWED.some((re) => re.test(path))) {
    res.status(400).json({ message: 'Not an allowed GitHub API path.' });
    return;
  }
  const query = req.query.recursive ? `?recursive=${encodeURIComponent(req.query.recursive)}` : '';
  const token = process.env.GITHUB_TOKEN;

  try {
    const upstream = await fetch(`https://api.github.com/${path}${query}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'repo-runner',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    for (const h of ['x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // Trees and blobs are addressed by content; cache them briefly at the edge.
    if (upstream.ok) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(upstream.status).json(await upstream.json());
  } catch {
    res.status(502).json({ message: 'Could not reach GitHub.' });
  }
}
