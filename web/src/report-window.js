// Opens the printable report in exactly one same-origin browsing context. We
// deliberately ask for a writable about:blank window instead of combining
// noopener with window.open('', ...): several browsers return null for that
// combination while still creating a popup, which led to a second window. The
// opener reference is cleared immediately after the single open, and printing
// is driven from this opener so the report needs no inline script.
export function openPrintWindow(html, win = window, options = {}) {
  const child = win.open('about:blank', '_blank');
  if (!child) return false;
  try { child.opener = null; } catch (e) { /* already isolated */ }

  child.document.write(html);
  child.document.close();

  const print = () => {
    try {
      if (typeof child.focus === 'function') child.focus();
      if (typeof child.print === 'function') child.print();
    } catch (e) { /* user closed the window before printing */ }
  };
  const schedule = options.schedulePrint || ((fn) => setTimeout(fn, options.printDelay ?? 300));
  schedule(print);
  return true;
}
