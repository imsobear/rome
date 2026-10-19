// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useComposedInput } from "./use-composed-input";

function Box({ value }: { value: string }) {
  return <input aria-label="box" {...useComposedInput(value, () => {})} />;
}

afterEach(cleanup);

describe("useComposedInput", () => {
  it("keeps the draft when its own earlier write arrives late", () => {
    const { rerender } = render(<Box value="" />);
    const box = screen.getByLabelText("box") as HTMLInputElement;

    fireEvent.input(box, { target: { value: "a" } });
    fireEvent.input(box, { target: { value: "ab" } });
    rerender(<Box value="a" />);
    expect(box.value).toBe("ab");

    rerender(<Box value="ab" />);
    expect(box.value).toBe("ab");
  });

  it("follows a value that changed from outside", () => {
    const { rerender } = render(<Box value="" />);
    const box = screen.getByLabelText("box") as HTMLInputElement;

    fireEvent.input(box, { target: { value: "a" } });
    rerender(<Box value="nadia" />);
    expect(box.value).toBe("nadia");
  });
});
