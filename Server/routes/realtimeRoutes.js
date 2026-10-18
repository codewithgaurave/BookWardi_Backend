import express from "express";
import { handleRealtimeStream, broadcastRealtimeEvent, getConnectedClientsCount } from "../services/realtimeService.js";

const router = express.Router();

// SSE stream for real-time dashboards
router.get("/stream", handleRealtimeStream);

// Optional HTTP broadcast fallback
router.post("/broadcast", (req, res) => {
  broadcastRealtimeEvent(req.body);
  res.json({ success: true, count: getConnectedClientsCount() });
});

export default router;
