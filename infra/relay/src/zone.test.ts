import * as Alchemy from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { RelayDeploymentConfig } from "./zone.ts";

function resolveRelayDeploymentConfig(env: Record<string, string>, stage = "prod") {
  return Effect.runPromise(
    RelayDeploymentConfig.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Alchemy.Stage, stage),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ),
      ),
    ),
  );
}

describe("RelayDeploymentConfig", () => {
  it("derives the relay domain from the unprefixed zone name", async () => {
    await expect(resolveRelayDeploymentConfig({ RELAY_ZONE_NAME: "example.com" })).resolves.toEqual(
      {
        stage: "prod",
        relayPublicDomain: "relay.example.com",
        relayPublicOrigin: "https://relay.example.com",
        managedEndpointZoneName: "example.com",
      },
    );
  });

  it("uses the unprefixed relay domain override", async () => {
    await expect(
      resolveRelayDeploymentConfig(
        {
          RELAY_ZONE_NAME: "example.com",
          RELAY_DOMAIN: "relay.custom.example",
        },
        "dev_julius",
      ),
    ).resolves.toEqual({
      stage: "dev_julius",
      relayPublicDomain: "relay.custom.example",
      relayPublicOrigin: "https://relay.custom.example",
      managedEndpointZoneName: "example.com",
    });
  });
});
