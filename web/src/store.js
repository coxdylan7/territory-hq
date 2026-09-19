import { create } from 'zustand';
import { api, setSessionHooks, getToken, setToken, clearToken } from './api';
import { currentWeekKey } from './utils';

const DEFAULT_SETTINGS = {
  homeAddress: '', homeLat: null, homeLng: null, counties: [], workDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  mileageRate: 0.70, gmapsKey: '', defaultCredit: 0, alertEmail: '',
};

// A Google Maps key must look like "AIza...". Anything else (typos, passwords,
// junk) is treated as no key so it can never break geocoding or routing.
export function validGmapsKey(k) {
  const v = (k || '').trim();
  return /^AIza[A-Za-z0-9_-]{10,}$/.test(v) ? v : '';
}

let toastTimer = null;

export const useStore = create((set, get) => ({
  // auth flow: 'boot' (checking) | 'none' (signed out) | 'pending' (awaiting approval/expired) | 'app'
  auth: getToken() ? 'boot' : 'none',
  pendingReason: '',
  user: null,
  tab: 'dashboard',
  routeDay: null,
  planWeek: currentWeekKey(),
  routeResult: null,
  routeLoading: false,
  routeError: '',
  visitLoading: false,
  blastLoading: false,
  acctSort: 'recent',
  settings: DEFAULT_SETTINGS,
  accounts: [],
  expenses: [],
  ocmSeen: [],
  ocmResults: [],
  ocmLoading: false,
  ocmError: '',
  ocmSearchMode: 'license',
  ocmSearchLoading: false,
  ocmSearchError: '',
  ocmSearchResults: null,
  toast: '',
  weekPlan: {},
  routeLog: [],
  credits: [],
  messages: [],
  bookings: [],
  eventTypes: [],
  portalUsers: [],
  reportPeriod: 'week',
  reportRef: null,
  lastCreditDraft: '',
  adminUsers: null,

  set: (patch) => set(patch),

  showToast: (msg) => {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: '' }), 2500);
  },

  init: async () => {
    if (!getToken()) { set({ auth: 'none', user: null }); return; }
    try {
      const user = await api.get('/api/me');
      set({ user });
    } catch (e) {
      return; // 401/402 hook already switched the screen
    }
    const u = get().user;
    if (!u || u.status !== 'active') {
      set({ auth: 'pending', pendingReason: u && u.status === 'expired' ? 'expired' : '' });
      return;
    }
    try {
      const normDate = (rows) => (rows || []).map((r) => ({ ...r, date: r.date || '' }));
      const [settings, accounts, expenses, ocmSeen, weekPlan, routeLog, credits, messages, bookings, eventTypes, portalUsers] = await Promise.all([
        api.get('/api/settings'),
        api.get('/api/accounts'),
        api.get('/api/expenses'),
        api.get('/api/ocm-seen'),
        api.get('/api/week-plan'),
        api.get('/api/route-log'),
        api.get('/api/credits'),
        api.get('/api/messages'),
        api.get('/api/bookings'),
        api.get('/api/event-types'),
        api.get('/api/portal-users'),
      ]);
      set({
        settings: { ...DEFAULT_SETTINGS, ...settings, gmapsKey: validGmapsKey(settings && settings.gmapsKey) },
        accounts: (accounts || []).map((a) => ({ ...a, lastVisited: a.lastVisited || null })),
        expenses: normDate(expenses),
        ocmSeen,
        weekPlan,
        routeLog: normDate(routeLog),
        credits: normDate(credits),
        messages: normDate(messages),
        bookings: bookings || [],
        eventTypes: eventTypes || [],
        portalUsers: portalUsers || [],
        auth: 'app',
      });
    } catch (e) {
      console.error('init load failed', e);
      if (get().auth === 'app') set({ auth: 'app' });
    }
  },

  logout: () => {
    try { api.post('/api/auth/logout').catch(() => {}); } catch (e) {}
    clearToken();
    set({ auth: 'none', user: null, adminUsers: null });
  },
}));

// Wire 401/402 handling into the API client.
setSessionHooks({
  onUnauthorized: () => { clearToken(); useStore.setState({ auth: 'none', user: null, adminUsers: null }); },
  onInactive: (reason) => useStore.setState({ auth: 'pending', pendingReason: reason === 'expired' ? 'expired' : '' }),
});

export function signIn(token, user) {
  setToken(token);
  useStore.setState({ user });
  useStore.getState().init();
}