import { type ChangeEvent, type CompositionEvent, useEffect, useState } from "react";

/**
 * Props for an input whose value lives somewhere a write re-renders it, such
 * as the URL. An input method's composition breaks if the value is replaced
 * mid-word, so the input keeps a local draft and calls `onCommit` only when no
 * composition is open.
 */
export function useComposedInput(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return {
    value: draft,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      if (!(event.nativeEvent as InputEvent).isComposing) onCommit(event.target.value);
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) =>
      onCommit(event.currentTarget.value),
  };
}
