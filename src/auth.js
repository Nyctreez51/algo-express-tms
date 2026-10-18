// auth.js — password hashing, sessions, and access-control middleware.
// Roles: owner > editor > viewer > driver.
//  - owner:  everything, including user management + API keys
//  - editor: all data entry (loads, expenses, drivers, trucks)
//  - viewer: read-only dashboards + settlements
//  - driver: ONLY their own driver pages (/driver/*). Nothing else.

'use strict';

const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const COOKIE_NAME = 'tms_session';

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

// Attach req.user (or null) from the session cookie. Runs on every request.
function loadSession(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const u = db.getSession(token);
    if (u && u.active) req.user = u;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

// Driver-role users may ONLY touch /driver/* and /logout.
// Everyone else is blocked from /driver/*.
function scopeGuard(req, res, next) {
  if (!req.user) return next();
  const isDriverPath = req.path === '/driver' || req.path.startsWith('/driver/');
  if (req.user.role === 'driver') {
    if (!isDriverPath && req.path !== '/logout') return res.redirect('/driver');
    return next();
  }
  if (isDriverPath) return res.redirect('/dashboard');
  next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.status(403).send('Forbidden');
    next();
  };
}

const canEdit = (req, res, next) =>
  requireRoles('owner', 'editor')(req, res, next);
const ownerOnly = (req, res, next) =>
  requireRoles('owner')(req, res, next);

function startSession(res, user) {
  const token = db.newSessionToken();
  db.createSession(token, user.id, SESSION_DAYS);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 864e5,
    secure: true, // HTTPS only (Railway serves TLS)
  });
}

function endSession(req, res) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) db.deleteSession(token);
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  COOKIE_NAME, SESSION_DAYS,
  hashPassword, verifyPassword,
  loadSession, requireAuth, scopeGuard, requireRoles, canEdit, ownerOnly,
  startSession, endSession,
};
