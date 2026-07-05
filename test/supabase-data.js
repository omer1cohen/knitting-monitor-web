// Reads the 3 Supabase tables and rebuilds the exact SNAPSHOT shape the dashboard
// expects (same as agent/export_json.py). Works in the browser and in Node.
(function (root) {
  // The agent writes LOCAL wall-clock times; Postgres labels them UTC (+00:00).
  // Strip the label so the browser treats them as the local times they really are.
  function wall(s) { return (s || '').replace(/(\.\d+)?(\+00:00|Z)$/, '$1'); }
  function durSec(since, until) {
    if (!since || !until) return 0;
    return Math.max(0, (Date.parse(until) - Date.parse(since)) / 1000);
  }
  function stationOf(stations, cid) {
    for (const s in stations) if (stations[s].includes(cid)) return s;
    return '?';
  }

  async function buildSnapshotFromSupabase(url, key, fetchFn, opts) {
    const f = fetchFn || fetch;
    const base = url.replace(/\/$/, '') + '/rest/v1';
    const H = { apikey: key, Authorization: 'Bearer ' + key };
    const get = async (path) => {
      const r = await f(base + path, { headers: H });
      if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return r.json();
    };
    const getAll = async (table, query) => {  // paginate (PostgREST caps ~1000/req)
      let out = [], from = 0; const page = 1000;
      for (;;) {
        const chunk = await get(`/${table}?${query}&limit=${page}&offset=${from}`);
        out = out.concat(chunk);
        if (chunk.length < page || from > 500000) break;
        from += page;
      }
      return out;
    };

    const ms = await getAll('machine_state', 'select=*&order=conveyor_id');
    const sb = await getAll('shift_buckets', 'select=*');
    const ev = (opts && opts.skipEvents) ? []
      : await getAll('events', 'select=time,conveyor_id,station,state,reason&order=time');

    ms.forEach(m => { m.since = wall(m.since); m.updated_at = wall(m.updated_at); });
    ev.forEach(e => { e.time = wall(e.time); });

    // A continuous stop longer than 24h = a BROKEN machine ("מושבתת"): shown gray
    // everywhere and fully excused from statistics -- retroactively, including the
    // partial stop time of the shift in which it broke (so nobody's numbers suffer).
    const BROKEN_AFTER_S = 24 * 3600;
    const broken = {};                                // conveyor_id -> since (epoch ms)
    ms.forEach(m => {
      if (m.state === 'stopped' && durSec(m.since, m.updated_at) > BROKEN_AFTER_S)
        broken[m.conveyor_id] = Date.parse(m.since);
    });
    const SHIFT_H = { morning: 6, afternoon: 14, night: 22 };
    sb.forEach(b => {
      b.gray_broken_s = 0;
      const bs = broken[b.conveyor_id];
      if (bs == null) return;
      const q = b.shift_date.split('-').map(Number);
      const h = SHIFT_H[b.shift_label] != null ? SHIFT_H[b.shift_label] : 6;
      const shiftEnd = new Date(q[0], q[1] - 1, q[2], h, 0, 0).getTime() + 8 * 3600 * 1000;
      if (shiftEnd > bs) { b.gray_broken_s = b.stop_s; b.stop_s = 0; b.stop_count = 0; }
    });

    const generated_at = ms.reduce((a, m) => (m.updated_at > a ? m.updated_at : a),
      ms.length ? ms[0].updated_at : new Date().toISOString());
    const stations = {};
    ms.forEach(m => { (stations[m.station] = stations[m.station] || []).push(m.conveyor_id); });

    const machines = ms.map(m => {
      const isBroken = broken[m.conveyor_id] != null;
      return {
        conveyor_id: m.conveyor_id, station: m.station,
        state: isBroken ? 'gray' : m.state, reason: isBroken ? 'broken' : m.reason,
        since: m.since, duration_s: durSec(m.since, m.updated_at),
      };
    });

    const order = { morning: 0, afternoon: 1, night: 2 };
    const byShift = {};
    sb.forEach(b => { (byShift[b.shift_date + '|' + b.shift_label + '|' + (b.shift_name || '')] ||= []).push(b); });
    const shifts = Object.keys(byShift).map(k => {
      const rows = byShift[k]; const [sd, label, name] = k.split('|');
      let run = 0, stop = 0, gp = 0, gs = 0, gg = 0, gb = 0, stops = 0; const per = {}; const mach = [];
      rows.forEach(b => {
        const bBroken = b.gray_broken_s || 0;
        run += b.run_s; stop += b.stop_s; gp += b.gray_power_s; gs += b.gray_station_s; gg += b.gray_gap_s; gb += bBroken; stops += b.stop_count;
        const st = stationOf(stations, b.conveyor_id);
        const grayAll = b.gray_power_s + b.gray_station_s + b.gray_gap_s + bBroken;
        const p = (per[st] ||= [0, 0, 0]); p[0] += b.run_s; p[1] += b.stop_s; p[2] += grayAll;
        const av = b.run_s + b.stop_s;
        mach.push({ conveyor_id: b.conveyor_id, station: st, run_s: b.run_s, stop_s: b.stop_s,
          gray_s: grayAll, stop_count: b.stop_count,
          stutter_count: b.stutter_count || 0, util: av > 0 ? b.run_s / av : 1 });
      });
      const av = run + stop; const per_station = {};
      for (const s in per) { const v = per[s]; per_station[s] = { run_s: v[0], stop_s: v[1], gray_s: v[2], util: (v[0] + v[1]) > 0 ? v[0] / (v[0] + v[1]) : 1 }; }
      return { shift_date: sd, shift_label: label, shift_name: name, run_s: run, stop_s: stop,
        gray_power_s: gp, gray_station_s: gs, gray_gap_s: gg, gray_broken_s: gb, stops, util: av > 0 ? run / av : 1,
        per_station, machines: mach.sort((a, b) => b.stop_s - a.stop_s) };
    }).sort((a, b) => a.shift_date < b.shift_date ? -1 : a.shift_date > b.shift_date ? 1 : order[a.shift_label] - order[b.shift_label]);

    return { generated_at, stations, n_conveyors: ms.length, machines, shifts, events: ev, broken };
  }

  root.buildSnapshotFromSupabase = buildSnapshotFromSupabase;
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildSnapshotFromSupabase };
})(typeof window !== 'undefined' ? window : globalThis);
