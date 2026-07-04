import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";

import { useThemeColor } from "../lib/useThemeColor";
import { ComposerToolbarButton } from "./ComposerToolbarTrigger";

/**
 * Joins two transcript fragments with a single separating space, skipping the
 * separator when either side is empty.
 */
function joinTranscript(prefix: string, next: string): string {
  if (!next) return prefix;
  if (!prefix) return next;
  return `${prefix} ${next}`;
}

/**
 * Android voice-dictation control for the thread composer. Tap to start, the
 * live transcript is appended into the composer draft as you speak, tap again
 * to stop. Recording state is surfaced with the accent-tinted mic icon.
 *
 * This is mounted only on Android (the composer gates it behind
 * `Platform.OS === "android"`), so the iOS composer code path is untouched.
 */
export function ComposerDictationButton(props: {
  readonly draftMessage: string;
  readonly onChangeDraftMessage: (value: string) => void;
}) {
  const { draftMessage, onChangeDraftMessage } = props;
  const iconColor = useThemeColor("--color-icon");
  const accentColor = useThemeColor("--color-primary");

  const [recognizing, setRecognizing] = useState(false);

  // Draft text captured when a dictation session begins (with a trailing space
  // separator when the existing draft needs one) — transcript is appended after
  // this prefix so we never clobber text the user already typed.
  const baseTextRef = useRef("");
  // Accumulated finalized transcript for the active session.
  const finalTextRef = useRef("");
  // Always call the latest draft setter, so native event listeners registered
  // once never close over a stale callback.
  const onChangeRef = useRef(onChangeDraftMessage);
  useEffect(() => {
    onChangeRef.current = onChangeDraftMessage;
  }, [onChangeDraftMessage]);

  const applyTranscript = useCallback((text: string) => {
    onChangeRef.current(baseTextRef.current + text);
  }, []);

  useSpeechRecognitionEvent("start", () => setRecognizing(true));
  useSpeechRecognitionEvent("end", () => setRecognizing(false));
  useSpeechRecognitionEvent("error", () => setRecognizing(false));
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    if (event.isFinal) {
      finalTextRef.current = joinTranscript(finalTextRef.current, transcript);
      applyTranscript(finalTextRef.current);
    } else {
      applyTranscript(joinTranscript(finalTextRef.current, transcript));
    }
  });

  // Stop any in-flight recognition if the composer unmounts mid-session.
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.stop();
    };
  }, []);

  const handlePress = useCallback(async () => {
    if (recognizing) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      return;
    }
    baseTextRef.current =
      draftMessage.length > 0 && !/\s$/.test(draftMessage) ? `${draftMessage} ` : draftMessage;
    finalTextRef.current = "";
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    });
  }, [draftMessage, recognizing]);

  return (
    <ComposerToolbarButton
      accessibilityLabel={recognizing ? "Stop dictation" : "Dictate message"}
      active={recognizing}
      onPress={() => void handlePress()}
      showChevron={false}
      iconNode={
        <SymbolView
          name={{ ios: recognizing ? "mic.fill" : "mic", android: "mic" }}
          size={16}
          tintColor={recognizing ? accentColor : iconColor}
          type="monochrome"
        />
      }
    />
  );
}
