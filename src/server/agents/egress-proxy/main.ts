/** Starts the allowlisted CONNECT proxy that gives isolated agent containers their only route to external hosts. */

import { startEgressProxy } from "./proxy.js";

const hosts = (process.env.STEWARD_EGRESS_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);
if (hosts.length === 0) throw new Error("STEWARD_EGRESS_ALLOWED_HOSTS must list at least one hostname");
const port = Number(process.env.STEWARD_EGRESS_PORT ?? "3128");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("STEWARD_EGRESS_PORT is invalid");
const proxy = await startEgressProxy({ host: "0.0.0.0", port, allowedHosts: hosts });
console.log(`steward-egress-proxy listening on ${proxy.port} for ${hosts.join(",")}`);
process.once("SIGTERM", () => {
  void proxy.close().then(() => process.exit(0));
});
