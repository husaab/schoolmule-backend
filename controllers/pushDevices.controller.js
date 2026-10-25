/*
  controllers/pushDevices.controller.js
  The signed-in person's phones and notification switches for the mobile
  app's push notifications (/api/profile/push-*). Open to every verified
  role, like the rest of /api/profile; every query is keyed on the caller.

  An admin "view as" preview never registers a phone: the preview token is
  read-only (verifyUser refuses its writes) and these refuse it again, so a
  preview can't route someone else's notifications to the admin's device.
*/

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/push.queries');
const { CATEGORIES, categoriesFor } = require('../services/push/categories');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;
const PLATFORMS = ['ios', 'android'];
const PREVIEW_MESSAGE = 'Notifications are not available in a preview.';

const rolesOf = (user) => (Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role]);

// PUT /api/profile/push-device { token, platform, appVersion? }
// Registers this phone for the caller (or moves it to them from whoever
// signed in on it before) and notes that it was seen.
const registerDevice = async (req, res) => {
  if (req.user.impersonator) return failed(res, 403, PREVIEW_MESSAGE);
  const { token, platform, appVersion } = req.body ?? {};
  if (typeof token !== 'string' || !EXPO_TOKEN.test(token)) return failed(res, 400, 'Not a push token');
  if (!PLATFORMS.includes(platform)) return failed(res, 400, 'Unknown platform');
  const version = typeof appVersion === 'string' ? appVersion.slice(0, 40) : null;
  try {
    await db.query(q.upsertDevice, [token, req.user.userId, platform, version]);
    return ok(res, { registered: true });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to register a push device');
    return failed(res, 500, 'Could not turn on notifications');
  }
};

// POST /api/profile/push-device/remove { token }
// Signing out: this phone stops getting the caller's notifications. Only the
// caller's own row goes, so a stale call after someone else signed in on the
// same phone changes nothing.
const removeDevice = async (req, res) => {
  if (req.user.impersonator) return failed(res, 403, PREVIEW_MESSAGE);
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || !token) return failed(res, 400, 'Not a push token');
  try {
    await db.query(q.deleteDevice, [req.user.userId, token]);
    return ok(res, { removed: true });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to remove a push device');
    return failed(res, 500, 'Could not turn off notifications');
  }
};

const preferencesView = (user, prefs, devices) => ({
  categories: categoriesFor(rolesOf(user)).map(({ key, label, description }) => ({
    key, label, description, enabled: prefs ? prefs[key] !== false : true,
  })),
  devices,
});

// GET /api/profile/push-preferences -> { categories: [{ key, label, description, enabled }], devices }
// The switches for the caller's roles (every view they hold).
const getPreferences = async (req, res) => {
  try {
    const [{ rows: [prefs] }, { rows: [count] }] = await Promise.all([
      db.query(q.selectPrefs, [req.user.userId]),
      db.query(q.countDevices, [req.user.userId]),
    ]);
    return ok(res, preferencesView(req.user, prefs, count?.n ?? 0));
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to load push preferences');
    return failed(res, 500, 'Could not load your notification settings');
  }
};

// PUT /api/profile/push-preferences { messages?: bool, announcements?: bool, ... }
// Changes only the switches sent; answers with the same shape as GET.
const setPreferences = async (req, res) => {
  if (req.user.impersonator) return failed(res, 403, PREVIEW_MESSAGE);
  const body = req.body ?? {};
  const allowed = new Set(categoriesFor(rolesOf(req.user)).map((c) => c.key));
  const values = CATEGORIES.map(({ key }) => {
    if (body[key] === undefined) return null;
    return typeof body[key] === 'boolean' && allowed.has(key) ? body[key] : undefined;
  });
  if (values.includes(undefined)) return failed(res, 400, 'Unknown notification setting');
  if (values.every((v) => v === null)) return failed(res, 400, 'Nothing to change');
  try {
    const { rows: [prefs] } = await db.query(q.upsertPrefs, [req.user.userId, ...values]);
    const { rows: [count] } = await db.query(q.countDevices, [req.user.userId]);
    return ok(res, preferencesView(req.user, prefs, count?.n ?? 0));
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to save push preferences');
    return failed(res, 500, 'Could not save your notification settings');
  }
};

module.exports = { registerDevice, removeDevice, getPreferences, setPreferences };
