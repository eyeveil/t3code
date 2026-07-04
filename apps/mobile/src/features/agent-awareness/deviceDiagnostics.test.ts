import { describe, expect, it } from "vite-plus/test";
import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

import { formatDeviceDiagnosticsRows } from "./deviceDiagnostics";

function makeDevice(diagnostics: RelayClientDeviceRecord["diagnostics"]): RelayClientDeviceRecord {
  return {
    deviceId: "device-1",
    label: "iPhone",
    platform: "ios",
    iosMajorVersion: 18,
    appVersion: "1.0.0",
    notifications: {
      enabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
    liveActivities: { enabled: true },
    ...(diagnostics ? { diagnostics } : {}),
    updatedAt: "2026-07-04T00:00:00.000Z",
  } as RelayClientDeviceRecord;
}

describe("formatDeviceDiagnosticsRows", () => {
  it("flags an unregistered device", () => {
    expect(formatDeviceDiagnosticsRows(null)).toEqual([
      { label: "Relay Registration", value: "Not registered", tone: "warn" },
    ]);
  });

  it("explains when the relay predates delivery diagnostics", () => {
    expect(formatDeviceDiagnosticsRows(makeDevice(undefined))).toEqual([
      { label: "Relay Registration", value: "Registered", tone: "ok" },
      { label: "Delivery Details", value: "Requires a relay update", tone: "muted" },
    ]);
  });

  it("warns about missing tokens and surfaces the last delivery failure", () => {
    const rows = formatDeviceDiagnosticsRows(
      makeDevice({
        bundleId: "com.t3tools.t3code.preview",
        apsEnvironment: "production",
        hasPushToken: false,
        hasPushToStartToken: false,
        hasLiveActivityToken: false,
        lastDeliveryAt: "2026-06-05T01:02:59.566Z",
        lastDeliveryKind: "live_activity_end",
        lastDeliveryStatus: 400,
        lastDeliveryError: "DeviceTokenNotForTopic",
      }),
    );

    expect(rows).toEqual([
      { label: "Notification Token", value: "Missing", tone: "warn" },
      { label: "Live Activity Start Token", value: "Missing", tone: "warn" },
      { label: "Active Live Activity", value: "None", tone: "muted" },
      {
        label: "APNs Route",
        value: "com.t3tools.t3code.preview (production)",
        tone: "muted",
      },
      {
        label: "Last Delivery",
        value: "DeviceTokenNotForTopic (400)",
        tone: "warn",
      },
    ]);
  });

  it("reports healthy registrations with a successful delivery", () => {
    const rows = formatDeviceDiagnosticsRows(
      makeDevice({
        bundleId: "com.t3tools.t3code",
        apsEnvironment: "production",
        hasPushToken: true,
        hasPushToStartToken: true,
        hasLiveActivityToken: true,
        lastDeliveryAt: "2026-07-04T00:00:00.000Z",
        lastDeliveryKind: "live_activity_update",
        lastDeliveryStatus: 200,
        lastDeliveryError: null,
      }),
    );

    expect(rows.slice(0, 3)).toEqual([
      { label: "Notification Token", value: "Registered", tone: "ok" },
      { label: "Live Activity Start Token", value: "Registered", tone: "ok" },
      { label: "Active Live Activity", value: "Connected", tone: "ok" },
    ]);
    expect(rows[4]).toMatchObject({ label: "Last Delivery", tone: "ok" });
    expect(rows[4]?.value).toContain("Delivered");
  });
});
