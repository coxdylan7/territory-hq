import { useStore } from './store';
import { AuthScreen, PendingScreen, Toast } from './components';
import { pendingReviews, currentPlan, currentWeekKey } from './utils';

import Dashboard from './tabs/Dashboard';
import Accounts from './tabs/Accounts';
import OCM from './tabs/OCM';
import RouteTab from './tabs/Route';
import RouteLog from './tabs/RouteLog';
import Credits from './tabs/Credits';
import Reports from './tabs/Reports';
import Messages from './tabs/Messages';
import Expenses from './tabs/Expenses';
import Bookings from './tabs/Bookings';
import Settings from './tabs/Settings';
import Admin from './tabs/Admin';

const TABS = [
  ['dashboard', 'Dashboard', '🏠'],
  ['accounts', 'Accounts', '🧾'],
  ['ocm', 'OCM Watch', '🛰️'],
  ['route', 'Weekly Route', '🗺️'],
  ['log', 'Route Log', '📓'],
  ['marketing', 'Credits', '💳'],
  ['bookings', 'Bookings', '🎟️'],
  ['reports', 'Reports', '📊'],
  ['messages', 'Messages', '✉️'],
  ['expenses', 'Expenses', '💵'],
  ['settings', 'Settings', '⚙️'],
  ['admin', 'Admin', '🛡️'],
];

export default function App() {
  const auth = useStore((s) => s.auth);

  if (auth === 'boot') return <div className="empty" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading…</div>;
  if (auth === 'none') return <AuthScreen />;
  if (auth === 'pending') return <PendingScreen reason={useStore.getState().pendingReason} />;

  return (
    <div id="app">
      <Nav />
      <main>
        <CurrentTab />
      </main>
      <Toast />
    </div>
  );
}

function CurrentTab() {
  const tab = useStore((s) => s.tab);
  switch (tab) {
    case 'dashboard': return <Dashboard />;
    case 'accounts': return <Accounts />;
    case 'ocm': return <OCM />;
    case 'route': return <RouteTab />;
    case 'log': return <RouteLog />;
    case 'marketing': return <Credits />;
    case 'bookings': return <Bookings />;
    case 'reports': return <Reports />;
    case 'messages': return <Messages />;
    case 'expenses': return <Expenses />;
    case 'settings': return <Settings />;
    case 'admin': return <Admin />;
    default: return <Dashboard />;
  }
}

function Nav() {
  const { tab, set, user, logout, accounts, weekPlan, routeLog, ocmResults, ocmSeen, bookings } = useStore();

  const plan = currentPlan(weekPlan);
  void plan; void routeLog;
  const newCount = ocmResults.filter((r) => !ocmSeen.includes(r.license_number)).length;
  const reviewCount = pendingReviews(weekPlan, routeLog).length;
  const bookingCount = bookings.filter((b) => b.status === 'requested').length;
  const badgeFor = (id) => {
    if (id === 'dashboard' && reviewCount > 0) return reviewCount;
    if (id === 'bookings' && bookingCount > 0) return bookingCount;
    if (id === 'ocm' && newCount > 0) return newCount;
    return null;
  };
  void accounts;

  const onTab = (id) => set({ tab: id });

  return (
    <nav>
      <div className="brand">
        <div className="logo">TH</div>
        <div>
          <h1>Territory HQ</h1>
          <span>field sales console</span>
        </div>
      </div>
      {TABS.filter(([id]) => id !== 'admin' || (user && user.role === 'admin')).map(([id, label, icon]) => {
        const badge = badgeFor(id);
        return (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => onTab(id)}>
            <span className="tabIcon">{icon}</span>
            <span className="tabLabel">{label}</span>
            {badge ? <span className="badge">{badge}</span> : null}
          </button>
        );
      })}
      <button className="tab" onClick={logout}>
        <span className="tabIcon">🚪</span>
        <span className="tabLabel">Sign out</span>
      </button>
    </nav>
  );
}