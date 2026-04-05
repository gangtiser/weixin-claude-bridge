import { loadSavedAuth, loginWithQrCode } from "./weixin/auth";
import { WeixinApi } from "./weixin/api";
import { Bridge } from "./bridge";

async function main(): Promise<void> {
  console.log("=== WeChat-Claude Bridge ===");
  console.log("Starting up...\n");

  // Step 1: Authenticate
  let auth = loadSavedAuth();
  if (!auth) {
    console.log("No saved auth found, starting QR login...\n");
    auth = await loginWithQrCode();
  }

  console.log(`[Main] Authenticated as bot: ${auth.ilink_bot_id}`);

  // Step 2: Initialize API client
  const api = new WeixinApi(auth);

  // Step 3: Verify connection by fetching config
  try {
    const config = await api.getConfig();
    console.log("[Main] Config fetched successfully:", JSON.stringify(config).substring(0, 200));
  } catch (err) {
    console.warn(
      "[Main] Failed to fetch config (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }

  // Step 4: Start bridge
  const bridge = new Bridge(api);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Main] Shutting down...");
    bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[Main] Bridge is running. Press Ctrl+C to stop.\n");
  await bridge.start();
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
