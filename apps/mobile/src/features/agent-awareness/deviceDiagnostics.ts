import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

export interface DeviceDiagnosticsRow {
  readonly label: string;
  readonly value: string;
  readonly tone: "ok" | "warn" | "muted";
}

function formatLastDeliveryTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Renders the relay's view of this device so "why am I not getting pushes"
// is answerable from the Settings screen instead of the relay database.
export function formatDeviceDiagnosticsRows(
  device: RelayClientDeviceRecord | null,
): ReadonlyArray<DeviceDiagnosticsRow> {
  if (device === null) {
    return [
      {
        label: "Relay Registration",
        value: "Not registered",
        tone: "warn",
      },
    ];
  }
  const diagnostics = device.diagnostics;
  if (!diagnostics) {
    return [
      { label: "Relay Registration", value: "Registered", tone: "ok" },
      { label: "Delivery Details", value: "Requires a relay update", tone: "muted" },
    ];
  }

  const rows: Array<DeviceDiagnosticsRow> = [
    {
      label: "Notification Token",
      value: diagnostics.hasPushToken ? "Registered" : "Missing",
      tone: diagnostics.hasPushToken ? "ok" : "warn",
    },
    {
      label: "Live Activity Start Token",
      value: diagnostics.hasPushToStartToken ? "Registered" : "Missing",
      tone: diagnostics.hasPushToStartToken ? "ok" : "warn",
    },
    {
      label: "Active Live Activity",
      value: diagnostics.hasLiveActivityToken ? "Connected" : "None",
      tone: diagnostics.hasLiveActivityToken ? "ok" : "muted",
    },
  ];

  if (diagnostics.bundleId) {
    rows.push({
      label: "APNs Route",
      value: `${diagnostics.bundleId} (${diagnostics.apsEnvironment ?? "default"})`,
      tone: "muted",
    });
  } else {
    rows.push({
      label: "APNs Route",
      value: "Relay default (update the app to register)",
      tone: "warn",
    });
  }

  if (diagnostics.lastDeliveryAt === null) {
    rows.push({ label: "Last Delivery", value: "None yet", tone: "muted" });
  } else if (diagnostics.lastDeliveryError !== null) {
    const status =
      diagnostics.lastDeliveryStatus === null ? "" : ` (${diagnostics.lastDeliveryStatus})`;
    rows.push({
      label: "Last Delivery",
      value: `${diagnostics.lastDeliveryError}${status}`,
      tone: "warn",
    });
  } else {
    const timestamp = formatLastDeliveryTimestamp(diagnostics.lastDeliveryAt);
    rows.push({
      label: "Last Delivery",
      value: timestamp ? `Delivered ${timestamp}` : "Delivered",
      tone: "ok",
    });
  }

  return rows;
}
