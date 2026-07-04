import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemeColor } from "../lib/useThemeColor";
import { AppText as Text } from "./AppText";

/**
 * Android-only Material 3 replacement for `@react-native-menu/menu`'s `MenuView`.
 *
 * The native Android path renders `android.widget.PopupMenu`, whose surface
 * (square corners, flat gray, no elevation tint) is dictated by the app's
 * native theme and cannot be styled from JS. This component renders the same
 * menu tree (title, actions, one level of drill-in submenus, checkmark state,
 * disabled/destructive attributes) as a tonal, rounded, elevated Material 3
 * surface built entirely from theme tokens, so it sits correctly over the
 * composer card instead of floating as a bare rectangle.
 *
 * iOS keeps the real `MenuView` (native `UIMenu` / liquid glass) — see
 * `ControlPillMenu`, which only routes Android here.
 */

const MENU_CORNER_RADIUS = 16;
const MENU_MIN_WIDTH = 224;
const MENU_ITEM_MIN_HEIGHT = 48;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;
const LONG_PRESS_MS = 350;

type MenuLevel = { readonly title?: string; readonly actions: readonly MenuAction[] };

export interface MaterialMenuAndroidProps {
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly isAnchoredToRight?: boolean;
  readonly shouldOpenOnLongPress?: boolean;
  readonly onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  readonly onOpenMenu?: () => void;
  readonly onCloseMenu?: () => void;
  readonly children: ReactNode;
}

type AnchorRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function MaterialMenuAndroid(props: MaterialMenuAndroidProps) {
  const anchorRef = useRef<View>(null);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const [stack, setStack] = useState<readonly MenuLevel[]>([]);

  const { onOpenMenu, onCloseMenu, onPressAction, actions, title } = props;

  const openMenu = useCallback(() => {
    const node = anchorRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => {
      setAnchorRect({ x, y, width, height });
      setStack([{ title, actions }]);
      onOpenMenu?.();
    });
  }, [actions, title, onOpenMenu]);

  const closeMenu = useCallback(() => {
    setAnchorRect(null);
    setStack([]);
    onCloseMenu?.();
  }, [onCloseMenu]);

  const handleSelect = useCallback(
    (action: MenuAction) => {
      if (action.subactions && action.subactions.length > 0) {
        setStack((current) => [
          ...current,
          { title: action.title, actions: action.subactions ?? [] },
        ]);
        return;
      }
      closeMenu();
      if (action.id) {
        onPressAction?.({ nativeEvent: { event: action.id } });
      }
    },
    [closeMenu, onPressAction],
  );

  const goBack = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);

  const isOpen = anchorRect !== null && stack.length > 0;

  // Long-press mode (thread-row context menus): a gesture that only activates
  // on hold, so quick taps still reach the row's own Pressable underneath.
  const longPress = Gesture.LongPress()
    .minDuration(LONG_PRESS_MS)
    .onStart(() => {
      runOnJS(openMenu)();
    });

  const anchor = props.shouldOpenOnLongPress ? (
    <GestureDetector gesture={longPress}>
      <View ref={anchorRef} collapsable={false}>
        {props.children}
      </View>
    </GestureDetector>
  ) : (
    <Pressable
      ref={anchorRef}
      collapsable={false}
      accessibilityRole="button"
      onPress={openMenu}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View pointerEvents="none">{props.children}</View>
    </Pressable>
  );

  return (
    <>
      {anchor}
      {isOpen ? (
        <Modal
          transparent
          statusBarTranslucent
          visible
          animationType="none"
          onRequestClose={closeMenu}
        >
          <Pressable style={{ flex: 1 }} onPress={closeMenu}>
            <MaterialMenuSurface
              anchorRect={anchorRect}
              level={stack[stack.length - 1]}
              canGoBack={stack.length > 1}
              isAnchoredToRight={props.isAnchoredToRight ?? false}
              onSelect={handleSelect}
              onBack={goBack}
            />
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

function MaterialMenuSurface(props: {
  readonly anchorRect: AnchorRect;
  readonly level: MenuLevel;
  readonly canGoBack: boolean;
  readonly isAnchoredToRight: boolean;
  readonly onSelect: (action: MenuAction) => void;
  readonly onBack: () => void;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const surfaceColor = useThemeColor("--color-menu-surface");
  const borderColor = useThemeColor("--color-border");
  const separatorColor = useThemeColor("--color-separator");

  const { anchorRect } = props;
  const maxWidth = screenWidth - SCREEN_MARGIN * 2;
  const menuWidth = Math.max(MENU_MIN_WIDTH, Math.min(anchorRect.width, maxWidth));

  const spaceBelow =
    screenHeight - insets.bottom - SCREEN_MARGIN - (anchorRect.y + anchorRect.height);
  const spaceAbove = anchorRect.y - insets.top - SCREEN_MARGIN;
  const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(160, (openUp ? spaceAbove : spaceBelow) - ANCHOR_GAP);

  const horizontal: { left?: number; right?: number } = props.isAnchoredToRight
    ? {
        right: Math.max(SCREEN_MARGIN, screenWidth - (anchorRect.x + anchorRect.width)),
      }
    : {
        left: Math.min(
          Math.max(anchorRect.x, SCREEN_MARGIN),
          Math.max(SCREEN_MARGIN, screenWidth - SCREEN_MARGIN - menuWidth),
        ),
      };

  const vertical = openUp
    ? { bottom: screenHeight - anchorRect.y + ANCHOR_GAP }
    : { top: anchorRect.y + anchorRect.height + ANCHOR_GAP };

  return (
    // Swallow taps on the surface so they don't fall through to the backdrop.
    <Pressable onPress={() => {}} style={{ position: "absolute", ...horizontal, ...vertical }}>
      <Animated.View
        entering={FadeIn.duration(120)}
        style={{
          minWidth: menuWidth,
          maxWidth,
          maxHeight,
          borderRadius: MENU_CORNER_RADIUS,
          backgroundColor: surfaceColor,
          borderWidth: 1,
          borderColor,
          overflow: "hidden",
          elevation: 8,
          paddingVertical: 6,
        }}
      >
        <ScrollView
          bounces={false}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {props.canGoBack ? (
            <MaterialMenuBackHeader
              title={props.level.title}
              separatorColor={separatorColor}
              onPress={props.onBack}
            />
          ) : props.level.title ? (
            <MaterialMenuTitle title={props.level.title} />
          ) : null}
          {props.level.actions
            .filter((action) => !action.attributes?.hidden)
            .map((action, index) => (
              <MaterialMenuRow
                key={action.id ?? `${action.title}:${index}`}
                action={action}
                onPress={props.onSelect}
              />
            ))}
        </ScrollView>
      </Animated.View>
    </Pressable>
  );
}

function MaterialMenuTitle(props: { readonly title: string }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 }}>
      <Text className="text-xs font-t3-bold text-foreground-muted" numberOfLines={1}>
        {props.title}
      </Text>
    </View>
  );
}

function MaterialMenuBackHeader(props: {
  readonly title?: string;
  readonly separatorColor: ColorValue;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const rippleColor = useThemeColor("--color-menu-ripple");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      android_ripple={{ color: rippleColor as string }}
      onPress={props.onPress}
      style={{
        minHeight: MENU_ITEM_MIN_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: props.separatorColor,
        marginBottom: 4,
      }}
    >
      <SymbolView
        name={{ ios: "chevron.left", android: "arrow_back" }}
        size={20}
        tintColor={iconColor}
        type="monochrome"
      />
      {props.title ? (
        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
      ) : null}
    </Pressable>
  );
}

const MaterialMenuRow = memo(function MaterialMenuRow(props: {
  readonly action: MenuAction;
  readonly onPress: (action: MenuAction) => void;
}) {
  const { action } = props;
  const foreground = useThemeColor("--color-foreground");
  const foregroundMuted = useThemeColor("--color-foreground-muted");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const accentColor = useThemeColor("--color-primary");
  const rippleColor = useThemeColor("--color-menu-ripple");

  const disabled = action.attributes?.disabled ?? false;
  const destructive = action.attributes?.destructive ?? false;
  const hasSubmenu = (action.subactions?.length ?? 0) > 0;
  const titleColor = destructive ? dangerColor : foreground;

  return (
    <Pressable
      accessibilityRole={hasSubmenu ? "button" : "menuitem"}
      accessibilityLabel={action.title}
      accessibilityState={{ disabled, selected: action.state === "on" }}
      android_ripple={disabled ? undefined : { color: rippleColor as string }}
      disabled={disabled}
      onPress={() => props.onPress(action)}
      style={{
        minHeight: MENU_ITEM_MIN_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: titleColor }} className="text-base font-t3-medium" numberOfLines={1}>
          {action.title}
        </Text>
        {action.subtitle ? (
          <Text style={{ color: foregroundMuted }} className="text-xs" numberOfLines={1}>
            {action.subtitle}
          </Text>
        ) : null}
      </View>
      {hasSubmenu ? (
        <SymbolView
          name={{ ios: "chevron.right", android: "chevron_right" }}
          size={18}
          tintColor={iconSubtle}
          type="monochrome"
        />
      ) : action.state === "on" ? (
        <SymbolView
          name={{ ios: "checkmark", android: "check" }}
          size={18}
          tintColor={accentColor}
          type="monochrome"
        />
      ) : null}
    </Pressable>
  );
});
