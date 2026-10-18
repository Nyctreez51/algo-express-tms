// server.js — ALGO Express TMS. One command to run:  npm start
// Serves the web app + JSON sync API. SQLite database lives in ./data/.

'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const routes = require('./src/routes');
const auth = require('./src/auth');

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(auth.loadSession); // attaches req.user on every request
app.use('/', routes);

// 404 + error handling
app.use((req, res) => res.status(404).send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`ALGO Express TMS running on http://localhost:${PORT}`);
});
