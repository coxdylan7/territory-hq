// A pending signup returns { ok: true, pending: true } but intentionally has no
// session cookie. Treat it as its own outcome: calling signIn(undefined) would
// trigger init() and a /api/me loop that bounces the user back to login.
export function applySignupResult(data, actions) {
  if (!data || data.pending || !data.user) {
    actions.pending();
    return 'pending';
  }
  actions.signIn(data.user);
  return 'app';
}
