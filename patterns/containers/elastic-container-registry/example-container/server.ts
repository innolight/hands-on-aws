import express from 'express';

const app = express();
const port = 3000;

const quotes = [
  "Premature optimization is the root of all evil. — Donald Knuth",
  "Any organization that designs a system will produce a design whose structure is a copy of the organization's communication structure. — Conway's Law",
  "There are only two hard things in Computer Science: cache invalidation and naming things. — Phil Karlton",
  "Make it work, make it right, make it fast. — Kent Beck",
  "Debugging is twice as hard as writing the code in the first place. — Brian Kernighan",
  "The best performance improvement is the transition from the nonworking state to the working state. — J. Osterhout",
  "Programs must be written for people to read, and only incidentally for machines to execute. — Abelson & Sussman",
  "Simplicity is the soul of efficiency. — Austin Freeman",
];

app.get('/health', (_req, res) => {
  res.json({status: 'ok'});
});

app.get('/quote', (req, res) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey || req.headers['x-api-key'] !== apiKey) {
    res.status(401).json({error: 'Unauthorized'});
    return;
  }
  const quote = quotes[Math.floor(Math.random() * quotes.length)];
  res.json({quote});
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
