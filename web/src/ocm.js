// OCM open-data pulls — ports of fetchOCM / searchOCM from the original.
import { useStore } from './store';

const OCM_DS = 'https://data.ny.gov/resource/jskf-tt3q.json';

// "2026-09-18T00:00:00.000" (or "MM/DD/YYYY") -> timestamp; null-safe.
function openedTs(r) {
  const v = r.retail_date_opened_to_public;
  if (!v) return null;
  const t = Date.parse(v);
  if (!isNaN(t)) return t;
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? Date.parse(m[3] + '-' + m[1] + '-' + m[2]) : null;
}

export async function fetchOCM() {
  const st = useStore.getState();
  st.set({ ocmLoading: true, ocmError: '' });
  try {
    let url = OCM_DS + '?$limit=5000&$where=' +
      encodeURIComponent(`license_type like '%Retail%' AND license_status = 'Active'`);
    const res = await fetch(url);
    if (!res.ok) throw new Error('OCM API http ' + res.status);
    let data = await res.json();
    const counties = st.settings.counties;
    if (counties.length) {
      data = data.filter((d) => counties.includes(d.county));
    }
    const addedLicenses = new Set(st.accounts.map((a) => a.licenseNumber).filter(Boolean));
    data = data.filter((d) => !addedLicenses.has(d.license_number));
    data.sort((a, b) => (openedTs(b) || 0) - (openedTs(a) || 0));
    st.set({ ocmResults: data, ocmLoading: false });
  } catch (e) {
    st.set({ ocmLoading: false, ocmError: 'Could not reach the OCM open data API right now. (' + e.message + ')' });
  }
}

export async function searchOCM(query) {
  const st = useStore.getState();
  st.set({ ocmSearchLoading: true, ocmSearchError: '', ocmSearchResults: null });
  try {
    const q = query.replace(/'/g, "''");
    const where = `(license_number like upper('%${q}%') OR upper(entity_name) like upper('%${q}%') OR upper(dba) like upper('%${q}%') OR upper(city) like upper('%${q}%'))`;
    const url = OCM_DS + '?$limit=25&$where=' + encodeURIComponent(where);
    const res = await fetch(url);
    if (!res.ok) throw new Error('OCM API http ' + res.status);
    const data = await res.json();
    if (!data.length) { st.set({ ocmSearchLoading: false, ocmSearchError: 'No matches for "' + query + '".' }); return; }
    data.sort((a, b) => (openedTs(b) || 0) - (openedTs(a) || 0));
    st.set({ ocmSearchLoading: false, ocmSearchResults: data });
  } catch (e) {
    st.set({ ocmSearchLoading: false, ocmSearchError: 'Search failed: ' + e.message });
  }
}