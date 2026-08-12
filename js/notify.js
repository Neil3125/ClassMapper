// "Leave by" alerts.
//
// Browser notifications only fire while the app is open — going further needs a
// push server, which this app deliberately doesn't have. Each class fires at
// most once per day, tracked in storage so a refresh doesn't re-alert you.

import { read, write, KEYS, settings, saveSettings } from './store.js';

export function supported() {
  return 'Notification' in window;
}

export function permission() {
  return supported() ? Notification.permission : 'unsupported';
}

export async function enable() {
  if (!supported()) throw new Error("This browser doesn't support notifications");
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    saveSettings({ notifications: false });
    throw new Error('Notifications were blocked. Enable them in your browser site settings.');
  }
  saveSettings({ notifications: true });
  return true;
}

export function disable() {
  saveSettings({ notifications: false });
}

export function enabled() {
  return settings().notifications && permission() === 'granted';
}

function todayKey(d = new Date()) {
  // Local-date key, built from parts so there's no UTC shift.
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function fired() {
  const store = read(KEYS.FIRED, {});
  const key = todayKey();
  if (store.day !== key) return { day: key, ids: [] };
  return store;
}

function markFired(id) {
  const store = fired();
  if (!store.ids.includes(id)) store.ids.push(id);
  write(KEYS.FIRED, store);
}

export function alreadyFired(id) {
  return fired().ids.includes(id);
}

/**
 * Fire the leave-now alert for a class, once per day.
 * `leaveAt` is a Date; we alert when now >= leaveAt.
 */
export function maybeAlert({ cls, leaveAt, walkMin, buildingName }, now = new Date()) {
  if (!enabled()) return false;
  if (now < leaveAt) return false;

  const id = `${cls.id}:${cls.startMin}`;
  if (alreadyFired(id)) return false;

  // Don't fire a stale alert for something you're already late for by 10+ min.
  if (now - leaveAt > 10 * 60000) {
    markFired(id);
    return false;
  }

  try {
    const n = new Notification(`Time to leave for ${cls.code || 'class'}`, {
      body: `${walkMin} min walk to ${buildingName}${cls.room ? ` · Room ${cls.room}` : ''}`,
      tag: id,
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    markFired(id);
    return true;
  } catch (err) {
    console.warn('Notification failed', err);
    return false;
  }
}

/** Test notification so you can confirm it works before relying on it. */
export function testAlert() {
  if (permission() !== 'granted') throw new Error('Enable notifications first');
  new Notification('ClassMapper alerts are working', {
    body: "You'll get a nudge like this when it's time to leave.",
  });
}
