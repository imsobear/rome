import { type ChangeEvent, type CompositionEvent, useEffect, useRef, useState } from "react";

/**
 * Props for an input whose value lives somewhere a write re-renders it, such
 * as the URL. An input method's composition breaks if the value is replaced
 * mid-word, so the input keeps a local draft and calls `onCommit` only when no
 * composition is open.
 */
export function useComposedInput(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  // Values this input wrote that have not come back yet. React Router updates
  // the location in a transition, so a write can arrive after the draft has
  // moved on, and copying it back would drop what was typed since.
  const pending = useRef<string[]>([]);

  useEffect(() => {
    const index = pending.current.indexOf(value);
    if (index >= 0) {
      pending.current.splice(0, index + 1);
      return;
    }
    pending.current = [];
    setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next === (pending.current[pending.current.length - 1] ?? value)) return;
    pending.current.push(next);
    onCommit(next);
  };

  return {
    value: draft,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      if (!(event.nativeEvent as InputEvent).isComposing) commit(event.target.value);
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) =>
      commit(event.currentTarget.value),
  };
}
