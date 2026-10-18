/**
 * FCM & Push Notification Helper Utilities
 * Handles token deduplication, platform tagging, multi-device tracking, and removal.
 */

// Helper: Safely insert or refresh an FCM device registration token
export const upsertFcmToken = (doc, { fcmToken, platform = "android", deviceId = "" }) => {
  if (!doc || !fcmToken) return false;
  const tokenStr = String(fcmToken).trim();
  if (!tokenStr) return false;

  doc.fcmToken = tokenStr;
  if (!Array.isArray(doc.fcmTokens)) {
    doc.fcmTokens = [];
  }

  const existingIndex = doc.fcmTokens.findIndex(
    (t) => t.token === tokenStr || (deviceId && t.deviceId && t.deviceId === deviceId)
  );

  if (existingIndex >= 0) {
    doc.fcmTokens[existingIndex].token = tokenStr;
    doc.fcmTokens[existingIndex].lastActive = new Date();
    if (platform) doc.fcmTokens[existingIndex].platform = platform;
    if (deviceId) doc.fcmTokens[existingIndex].deviceId = deviceId;
  } else {
    // Keep max 10 active tokens per user/entity to avoid unbounded growth
    if (doc.fcmTokens.length >= 10) {
      doc.fcmTokens.sort((a, b) => new Date(a.lastActive) - new Date(b.lastActive));
      doc.fcmTokens.shift();
    }
    doc.fcmTokens.push({
      token: tokenStr,
      platform: platform || "android",
      deviceId: deviceId || "",
      lastActive: new Date()
    });
  }
  return true;
};

// Helper: Remove an FCM device registration token (e.g., upon logout)
export const removeFcmTokenFromDoc = (doc, tokenStr) => {
  if (!doc || !tokenStr) return false;
  const cleanToken = String(tokenStr).trim();
  if (!cleanToken) return false;

  let modified = false;
  if (doc.fcmToken === cleanToken) {
    doc.fcmToken = "";
    modified = true;
  }
  if (Array.isArray(doc.fcmTokens)) {
    const prevLen = doc.fcmTokens.length;
    doc.fcmTokens = doc.fcmTokens.filter((t) => t.token !== cleanToken);
    if (doc.fcmTokens.length !== prevLen) {
      modified = true;
    }
    // If fcmToken was cleared, restore to latest remaining token if any
    if (!doc.fcmToken && doc.fcmTokens.length > 0) {
      doc.fcmToken = doc.fcmTokens[doc.fcmTokens.length - 1].token;
    }
  }
  return modified;
};
