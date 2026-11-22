// External links opened via window.open must not retain a reference to the
// portal. The feature string isolates the new window; clearing opener is
// defence in depth for browsers that ignore it for certain URL schemes.
export function openExternal(url, win = window) {
  const child = win.open(url, '_blank', 'noopener,noreferrer');
  if (child) {
    try { child.opener = null; } catch (e) { /* already isolated */ }
  }
  return child;
}
