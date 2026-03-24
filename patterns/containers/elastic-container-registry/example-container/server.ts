import express from 'express';

const app = express();
const port = 3000;

const quotes = [
  'Premature optimization is the root of all evil. — Donald Knuth',
  "Any organization that designs a system will produce a design whose structure is a copy of the organization's communication structure. — Conway's Law",
  'There are only two hard things in Computer Science: cache invalidation and naming things. — Phil Karlton',
  'Make it work, make it right, make it fast. — Kent Beck',
  'Debugging is twice as hard as writing the code in the first place. — Brian Kernighan',
  'The best performance improvement is the transition from the nonworking state to the working state. — J. Osterhout',
  'Programs must be written for people to read, and only incidentally for machines to execute. — Abelson & Sussman',
  'Simplicity is the soul of efficiency. — Austin Freeman',
];

// ROUTE_PREFIX lets the ALB pattern mount routes under a path prefix (e.g. /quote-service).
// ALB does not rewrite paths — the container receives the full path as-is.
// Without ROUTE_PREFIX, routes stay at /health and /quote (backward-compatible).
const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

router.get('/quote', (req, res) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey || req.headers['x-api-key'] !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const quote = quotes[Math.floor(Math.random() * quotes.length)];
  res.json({ quote });
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use(process.env.ROUTE_PREFIX || '/', router);

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Close the listener so no new connections are accepted, then let in-flight requests finish.
function shutdown(signal: string) {
  console.log(`${signal} received, draining connections...`);
  server.close(() => {
    console.log('All connections drained, exiting.');
    process.exit(0);
  });
}

// ECS sends SIGTERM → stopTimeout (default 30s) → SIGKILL.
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Ctrl+C sends SIGINT
process.on('SIGINT', () => shutdown('SIGINT'));

// Node.js doesn't exit after the last line — it enters the event loop here.
