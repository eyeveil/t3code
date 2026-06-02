import { UserButton, Waitlist, useAuth, useClerk } from "@clerk/react";
import { useSignIn, useSignUp } from "@clerk/react/legacy";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { CloudIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DesktopCloudAuthOAuthStrategy,
  resolveDesktopCloudAuthOAuthOptions,
} from "../../cloud/desktopAuth";
import { updatePrimaryCloudPreferences } from "../../cloud/linkEnvironment";
import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { webRuntime } from "../../lib/runtime";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const NOTIFICATION_DEVICE_SKELETON_ROWS = ["primary", "secondary"] as const;

function NotificationDevicesSkeleton() {
  return NOTIFICATION_DEVICE_SKELETON_ROWS.map((row) => (
    <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32 rounded-full" />
        <Skeleton className="h-3 w-44 rounded-full" />
        <Skeleton className="h-3 w-56 rounded-full" />
      </div>
    </div>
  ));
}

function EmptyNotificationDevices() {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No notification devices</EmptyTitle>
        <EmptyDescription>
          Sign in on the mobile app to register a device for account-level notifications.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function hasClerkConfig(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

class CloudSettingsOperationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CloudSettingsOperationError";
    this.cause = cause;
  }
}

async function runCloudOperation<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new CloudSettingsOperationError(message, cause);
  }
}

function cloudErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CloudSettingsOperationError) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function CloudSettingsPanel() {
  if (!hasClerkConfig()) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
          <SettingsRow
            title="Cloud account"
            description="Set VITE_CLERK_PUBLISHABLE_KEY to enable optional cloud features."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <ConfiguredCloudSettingsPanel />;
}

function ConfiguredCloudSettingsPanel() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return null;
  }

  return isSignedIn ? <CloudSettingsPanelInner /> : <CloudWaitlistPanel />;
}

function CloudWaitlistPanel() {
  return (
    <SettingsPageContainer className="min-h-full items-center justify-center">
      <Waitlist />
      {isElectron ? (
        <div className="flex flex-col items-center gap-3 text-xs text-muted-foreground">
          <p>Already approved? Sign in through the desktop app.</p>
          <DesktopCloudSignInButton />
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}

function CloudSettingsPanelInner() {
  const primaryLinkState = usePrimaryCloudLinkState();
  const primarySessionState = usePrimarySessionState();
  const devicesState = useManagedRelayDevices();
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);
  const devices = devicesState.data ?? [];
  const canManageRelay =
    primarySessionState.data?.authenticated === true &&
    Boolean(primarySessionState.data.scopes?.includes(AuthRelayWriteScope));

  useEffect(() => {
    if (devicesState.error) {
      toastManager.add({
        type: "error",
        title: "Cloud devices unavailable",
        description: devicesState.error,
      });
    }
  }, [devicesState.error]);

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    try {
      await webRuntime.runPromise(updatePrimaryCloudPreferences({ publishAgentActivity: enabled }));
      primaryLinkState.refresh();
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment can publish agent activity to your notification devices."
          : "This environment will stop publishing agent activity.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud preference update failed",
        description: cloudErrorMessage(error, "Could not update cloud preferences."),
      });
    } finally {
      setIsUpdatingPreference(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow
          title="Cloud account"
          description="Manage your private-beta T3 Cloud session."
          control={<UserButton />}
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Publish agent activity"
          description="Allow this environment to send agent activity to your notification devices."
          status={
            !primaryLinkState.data?.linked ? "Link this environment from Connections first." : null
          }
          control={
            <Switch
              aria-label="Publish agent activity"
              checked={primaryLinkState.data?.publishAgentActivity ?? false}
              disabled={!primaryLinkState.data?.linked || !canManageRelay || isUpdatingPreference}
              onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Notification devices"
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={devicesState.isPending}
                  onClick={devicesState.refresh}
                  aria-label="Refresh notification devices"
                >
                  <RefreshCwIcon
                    className={cn("size-3", devicesState.isPending && "animate-spin")}
                  />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh notification devices</TooltipPopup>
          </Tooltip>
        }
      >
        {devicesState.data === null ? (
          <NotificationDevicesSkeleton />
        ) : devices.length > 0 ? (
          devices.map((device) => (
            <SettingsRow
              key={device.deviceId}
              title={device.label}
              description={`iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`}
              status={
                device.notifications.enabled
                  ? device.liveActivities.enabled
                    ? "Notifications and Live Activities enabled"
                    : "Notifications enabled · Live Activities disabled"
                  : "Notifications disabled on device"
              }
            />
          ))
        ) : (
          <EmptyNotificationDevices />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DesktopCloudSignInButton() {
  const clerk = useClerk();
  const { setActive } = clerk;
  const { isLoaded: signInLoaded, signIn } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const [startingStrategy, setStartingStrategy] = useState<DesktopCloudAuthOAuthStrategy | null>(
    null,
  );
  const oauthOptions = resolveDesktopCloudAuthOAuthOptions(clerk);
  const callbackCleanupRef = useRef<(() => void) | null>(null);

  const clearCallbackListener = useCallback(() => {
    callbackCleanupRef.current?.();
    callbackCleanupRef.current = null;
  }, []);

  const completeOAuthCallback = useCallback(
    async (rawUrl: string) => {
      if (!signInLoaded || !signIn || !signUpLoaded || !signUp) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: "Clerk is still loading. Try signing in again.",
        });
        return;
      }

      let rotatingTokenNonce: string | null = null;
      let sessionId: string | null = null;
      try {
        const callbackUrl = new URL(rawUrl);
        rotatingTokenNonce = callbackUrl.searchParams.get("rotating_token_nonce");
        sessionId = callbackUrl.searchParams.get("created_session_id");
      } catch {
        // Handled by the explicit nonce check below.
      }
      if (!rotatingTokenNonce) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description:
            "Clerk did not return a native session nonce. Verify this redirect URL is allowlisted for native SSO redirects.",
        });
        return;
      }

      try {
        await runCloudOperation(
          () => signIn.reload({ rotatingTokenNonce }),
          "Could not reload the desktop sign-in session.",
        );
        sessionId = sessionId || signIn.createdSessionId;

        if (!sessionId && signIn.firstFactorVerification.status === "transferable") {
          const signUpAttempt = await runCloudOperation(
            () => signUp.create({ transfer: true }),
            "Could not transfer the desktop sign-up session.",
          );
          sessionId = signUpAttempt.createdSessionId;
        }

        if (!sessionId) {
          throw new CloudSettingsOperationError("Clerk did not create a desktop session.");
        }

        await runCloudOperation(
          () => setActive({ session: sessionId! }),
          "Could not activate the desktop cloud session.",
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: cloudErrorMessage(error, "Could not complete cloud sign-in."),
        });
      }
    },
    [setActive, signIn, signInLoaded, signUp, signUpLoaded],
  );

  useEffect(() => {
    return () => {
      clearCallbackListener();
    };
  }, [clearCallbackListener]);

  const startOAuth = async (strategy: DesktopCloudAuthOAuthStrategy) => {
    if (!signInLoaded || !signIn) {
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: "Clerk is still loading. Try signing in again.",
      });
      return;
    }

    setStartingStrategy(strategy);
    clearCallbackListener();
    try {
      const redirectUrl = await runCloudOperation(
        () => window.desktopBridge?.createCloudAuthRequest() ?? Promise.resolve(undefined),
        "Desktop auth callback is unavailable.",
      );
      if (!redirectUrl) {
        throw new CloudSettingsOperationError("Desktop auth callback is unavailable.");
      }

      callbackCleanupRef.current =
        window.desktopBridge?.onCloudAuthCallback((rawUrl) => {
          clearCallbackListener();
          void completeOAuthCallback(rawUrl);
        }) ?? null;

      const signInAttempt = await runCloudOperation(
        () => signIn.create({ strategy, redirectUrl } as never),
        "Could not create the desktop OAuth request.",
      );
      const externalUrl =
        signInAttempt.firstFactorVerification.externalVerificationRedirectURL?.toString();
      if (!externalUrl) {
        throw new CloudSettingsOperationError(
          "Clerk did not return an external OAuth redirect URL.",
        );
      }

      const opened = await runCloudOperation(
        () => window.desktopBridge?.openExternal(externalUrl) ?? Promise.resolve(false),
        "Could not open the system browser.",
      );
      if (!opened) {
        throw new CloudSettingsOperationError("Could not open the system browser.");
      }
    } catch (error) {
      clearCallbackListener();
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: cloudErrorMessage(error, "Could not start cloud sign-in."),
      });
    } finally {
      setStartingStrategy(null);
    }
  };

  const isStarting = startingStrategy !== null;

  if (oauthOptions.length === 0) {
    return (
      <Button disabled size="sm">
        No OAuth providers enabled
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {oauthOptions.map((option) => (
        <Button
          key={option.strategy}
          disabled={isStarting}
          onClick={() => void startOAuth(option.strategy)}
          size="sm"
        >
          {startingStrategy === option.strategy ? "Opening..." : `Continue with ${option.label}`}
        </Button>
      ))}
    </div>
  );
}
