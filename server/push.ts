import webpush from "web-push";
import { config } from "./config.ts";
import { store } from "./store.ts";

// Web Push (works on iOS 16.4+ once the app is added to the Home Screen).
// VAPID keys come from .env or are generated once and kept in the local store.

export function vapidPublicKey(): string {
  if (config.push.publicKey && config.push.privateKey) return config.push.publicKey;
  if (!store.data.vapid) store.update("vapid", () => webpush.generateVAPIDKeys());
  return store.data.vapid!.publicKey;
}

export function initPush() {
  const pub = vapidPublicKey();
  const priv = config.push.privateKey || store.data.vapid!.privateKey;
  webpush.setVapidDetails(config.push.subject, pub, priv);
}

export async function sendPush(payload: { title: string; body: string; url?: string }) {
  const p = store.data.profile;
  if (!p.notifications.push) return;
  const h = new Date().getHours();
  const q = p.notifications.quietHours;
  if (q && (q[0] <= q[1] ? h >= q[0] && h < q[1] : h >= q[0] || h < q[1])) return;
  const dead: string[] = [];
  await Promise.all(
    store.data.pushSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as webpush.PushSubscription, JSON.stringify(payload));
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push((sub as { endpoint: string }).endpoint);
      }
    }),
  );
  if (dead.length) store.update("pushSubs", (s) => s.filter((x) => !dead.includes((x as { endpoint: string }).endpoint)));
}
