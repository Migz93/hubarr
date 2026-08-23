import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]"
].join(", ");

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("hidden") && element.getClientRects().length > 0);
}

function inertBackground(overlay: HTMLElement) {
  const changedElements = new Map<HTMLElement, boolean>();
  let child: HTMLElement = overlay;
  let parent = child.parentElement;

  // The dialogs are rendered in place rather than through a portal, so make every
  // sibling branch from the dialog to <body> unavailable to assistive technology.
  while (parent) {
    for (const sibling of parent.children) {
      if (
        !(sibling instanceof HTMLElement) ||
        sibling === child ||
        sibling.inert ||
        sibling.hasAttribute("data-overlay-backdrop")
      ) continue;
      changedElements.set(sibling, false);
      sibling.inert = true;
    }
    if (parent === document.body) break;
    child = parent;
    parent = parent.parentElement;
  }

  return () => {
    for (const [element, wasInert] of changedElements) {
      element.inert = wasInert;
    }
  };
}

/** Keeps a mounted overlay usable without a mouse and returns focus to its trigger. */
export function useAccessibleOverlay(
  overlayRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void
) {
  const onCloseRef = useRef(onClose);
  const restoreFocusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    if (restoreFocusTimerRef.current !== null) {
      window.clearTimeout(restoreFocusTimerRef.current);
      restoreFocusTimerRef.current = null;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = overlayRef.current;
    const restoreBackground = overlay ? inertBackground(overlay) : () => {};
    const focusInitialElement = () => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const focusable = getFocusableElements(overlay);
      (overlay.querySelector<HTMLElement>("[data-overlay-initial-focus]") ?? focusable[0] ?? overlay).focus();
    };

    focusInitialElement();
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const overlay = overlayRef.current;
      if (!overlay) return;
      const focusable = getFocusableElements(overlay);
      if (focusable.length === 0) {
        event.preventDefault();
        overlay.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      restoreBackground();
      if (previouslyFocused?.isConnected) {
        restoreFocusTimerRef.current = window.setTimeout(() => {
          if (previouslyFocused.isConnected && previouslyFocused.getClientRects().length > 0) {
            previouslyFocused.focus();
          }
          restoreFocusTimerRef.current = null;
        }, 0);
      }
    };
  }, [isOpen, overlayRef]);
}
