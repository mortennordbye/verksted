/**
 * What jsdom does not have and the libraries under test reach for on mount:
 * cmdk measures its list with a ResizeObserver and keeps the highlighted row in
 * view with scrollIntoView. Inert here, since jsdom lays nothing out. A suite
 * that needs either to do something stubs it itself, over these.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Checked by name: reading the method off the prototype to test it trips the
// unbound-method rule, and TypeScript is sure it is always there.
if (!Object.hasOwn(Element.prototype, "scrollIntoView")) {
  Object.assign(Element.prototype, { scrollIntoView: () => {} });
}
