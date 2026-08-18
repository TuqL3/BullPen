/**
 * Enter, but not the Enter that ends an IME composition.
 *
 * A Vietnamese, Japanese or Chinese input method uses Enter to accept the
 * candidate it is showing. Treating that as "submit" sent whatever half-formed
 * text was on screen and swallowed the keystroke that would have finished the
 * word - which is what "I cannot type Vietnamese in the inputs" looked like.
 */
export const onEnter =
  (run: (e: React.KeyboardEvent) => void) =>
  (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    run(e)
  }
