import { useEffect, useEffectEvent, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export function ExpandedImageDialog({ preview, onClose }: ExpandedImageDialogProps) {
  return (
    <ExpandedImageDialogContent
      key={getPreviewResetKey(preview)}
      preview={preview}
      onClose={onClose}
    />
  );
}

function getPreviewResetKey(preview: ExpandedImagePreview): string {
  return [
    preview.index,
    preview.images.length,
    ...preview.images.map((image) => `${image.src}\u0000${image.name}`),
  ].join("\u0001");
}

function useExpandedImageKeyboardShortcuts(input: {
  readonly canNavigate: boolean;
  readonly onClose: () => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}) {
  const handleKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.onClose();
      return;
    }
    if (!input.canNavigate) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      input.onPrevious();
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    input.onNext();
  });

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function ExpandedImageDialogContent({ preview, onClose }: ExpandedImageDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(preview.index);
  const images = preview.images;
  const canNavigate = images.length > 1;

  const navigateImage = (direction: -1 | 1) => {
    setCurrentIndex((existingIndex) => {
      if (!canNavigate) return existingIndex;
      const safeExistingIndex =
        existingIndex >= 0 && existingIndex < images.length ? existingIndex : preview.index;
      const nextIndex = (safeExistingIndex + direction + images.length) % images.length;
      return nextIndex === existingIndex ? existingIndex : nextIndex;
    });
  };

  useExpandedImageKeyboardShortcuts({
    canNavigate,
    onClose,
    onNext: () => navigateImage(1),
    onPrevious: () => navigateImage(-1),
  });

  const item = images[currentIndex];
  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {canNavigate && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {canNavigate ? ` (${currentIndex + 1}/${images.length})` : ""}
        </p>
      </div>
      {canNavigate && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
}
