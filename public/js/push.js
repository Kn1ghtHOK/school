import { api } from "./api.js";

function urlBase64ToUint8Array(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

/** iOS requires the site to be installed to the Home Screen before push works. */
export function pushBlockedReason() {
  if (!pushSupported()) return "This browser doesn't support push notifications.";
  if (isIOS() && !isStandalone()) {
    return "On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there to enable notifications.";
  }
  return null;
}

export async function enablePush() {
  const blocked = pushBlockedReason();
  if (blocked) throw new Error(blocked);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");

  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api.getPushPublicKey();
  if (!publicKey) throw new Error("Push isn't configured on the server yet (missing VAPID keys).");

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const label = `${navigator.platform || "device"} · ${new Date().toLocaleDateString()}`;
  await api.subscribePush(subscription.toJSON(), label);
  return subscription;
}

export async function disablePush() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
}

export async function currentPushStatus() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? "subscribed" : "not-subscribed";
}
