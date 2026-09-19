import { create } from 'zustand';
import { api, getToken, setToken, clearToken } from './api';

let toastTimer = null;

export const useStore = create((set, get) => ({
  auth: getToken() ? 'boot' : 'none',
  user: null,
  balance: null,
  eventTypes: [],
  bookings: [],
  toast: null,

  set: (p) => set(p),

  showToast(m) {
    clearTimeout(toastTimer);
    set({ toast: m });
    toastTimer = setTimeout(() => set({ toast: null }), 2800);
  },

  async init() {
    if (get().auth !== 'boot') return;
    try {
      const me = await api.get('/api/me');
      set({ user: me, auth: 'app' });
      await get().refresh(me);
    } catch (e) {
      clearToken();
      set({ auth: 'none', user: null });
    }
  },

  async refresh(me) {
    const u = me || get().user;
    if (!u) return;
    const calls = [api.get('/api/event-types'), api.get('/api/bookings')];
    if (u.role === 'client') calls.push(api.get('/api/balance'));
    try {
      const [eventTypes, bookings, balance] = await Promise.all(calls);
      set({ eventTypes, bookings, balance: u.role === 'client' ? balance.balance : null });
    } catch (e) {}
  },

  async login(email, password) {
    const r = await api.post('/api/auth/login', { email, password });
    if (!r.token) throw new Error('no token returned');
    setToken(r.token);
    set({ user: r.user, auth: 'app' });
    await get().refresh(r.user);
  },

  async logout() {
    try { await api.post('/api/auth/logout', {}); } catch (e) {}
    clearToken();
    set({ auth: 'none', user: null, balance: null, eventTypes: [], bookings: [] });
  },

  async book(payload) {
    const r = await api.post('/api/bookings', payload);
    await get().refresh();
    return r;
  },

  async cancelBooking(id) {
    await api.put('/api/bookings/' + id + '/cancel', {});
    await get().refresh();
  },
}));