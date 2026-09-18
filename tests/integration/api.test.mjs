/* Integration: the real Worker and the real local D1, over HTTP.
   Covers every collection the router exposes; each phase adds a section. */
// Same default as before; the override only exists so a future phase can
// point the same suite at a different local port.
const BASE = process.env.TAQWA_API_BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const sec = (s) => console.log('\n-- ' + s + ' --');
async function get(path, init) {
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ct: res.headers.get('content-type'), allow: res.headers.get('allow'), body };
}

sec('1. Health');
{
  const r = await get('/api/health');
  t('health 200', r.status === 200, r.status);
  t('health ok', r.body?.ok === true);
  t('database reachable', r.body?.data?.database?.reachable === true);
  t('migrated', r.body?.data?.database?.migrated === true);
  const routes = r.body?.data?.routes ?? [];
  t('advertises 9 routes', routes.length === 9, routes);
  t('advertises services list', routes.includes('GET /api/services'));
  t('advertises services detail', routes.includes('GET /api/services/:id'));
  t('advertises customers routes', routes.includes('GET /api/customers') && routes.includes('GET /api/customers/:id'));
  t('advertises vehicles routes', routes.includes('GET /api/vehicles') && routes.includes('GET /api/vehicles/:id'));
  t('advertises mechanics routes', routes.includes('GET /api/mechanics') && routes.includes('GET /api/mechanics/:id'));
}

sec('2. GET /api/services — list');
let list;
{
  const r = await get('/api/services');
  list = r.body;
  t('200', r.status === 200, r.status);
  t('json content-type', (r.ct || '').includes('application/json'), r.ct);
  t('no stray ok flag on list (envelope is {data,...meta})', !('ok' in list));
  t('data is an array', Array.isArray(list?.data));
  t('count 6', list?.count === 6, list?.count);
  t('total 6', list?.total === 6, list?.total);
  t('default limit 500', list?.limit === 500, list?.limit);
  t('default offset 0', list?.offset === 0, list?.offset);
  const ids = list.data.map(s => s.id);
  t('newest first, id DESC tie-break',
    JSON.stringify(ids) === JSON.stringify(['SRV-9006','SRV-9004','SRV-9003','SRV-9002','SRV-9001','SRV-9005']), ids);
}

sec('3. Record shape and NULL semantics');
{
  const byId = Object.fromEntries(list.data.map(s => [s.id, s]));
  const full = byId['SRV-9001'];
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('name', full.name === 'B4 Full Service', full.name);
  t('category', full.category === 'Engine');
  t('description', full.description === 'Complete engine overhaul');
  t('estTime is a number', full.estTime === 180, full.estTime);
  t('price is a number', full.price === 7500, full.price);
  t('status', full.status === 'Active');
  t('createdAt', full.createdAt === '2026-09-10T09:00:00', full.createdAt);
  t('updatedAt present when set', full.updatedAt === '2026-09-12T11:30:00', full.updatedAt);

  const sparse = byId['SRV-9002'];
  t('NULL category -> ""', sparse.category === '', sparse.category);
  t('NULL description -> ""', sparse.description === '', sparse.description);
  t('NULL est_time stays null, not 0', sparse.estTime === null, sparse.estTime);
  t('estTime is not 0', sparse.estTime !== 0);
  t('updatedAt omitted when NULL', !('updatedAt' in sparse), Object.keys(sparse));
  t('price keeps decimals', sparse.price === 1200.5, sparse.price);

  const retired = byId['SRV-9005'];
  t('Inactive status preserved', retired.status === 'Inactive', retired.status);
  t('price 0 stays 0', retired.price === 0, retired.price);
  t('est_time NULL -> null on inactive row', retired.estTime === null);

  const keys = new Set(list.data.flatMap(s => Object.keys(s)));
  t('no unexpected fields', [...keys].every(k =>
    ['id','name','category','description','estTime','price','status','createdAt','updatedAt'].includes(k)), [...keys]);
}

sec('4. Pagination');
{
  const r1 = await get('/api/services?limit=2');
  t('limit=2 returns 2', r1.body?.data?.length === 2, r1.body?.data?.length);
  t('limit echoed', r1.body?.limit === 2);
  t('total still 6', r1.body?.total === 6, r1.body?.total);
  t('count is page size', r1.body?.count === 2);

  const r2 = await get('/api/services?limit=2&offset=2');
  t('offset=2 returns next page', JSON.stringify(r2.body.data.map(s => s.id)) === JSON.stringify(['SRV-9003','SRV-9002']),
    r2.body.data.map(s => s.id));
  t('offset echoed', r2.body?.offset === 2);
  t('pages do not overlap', !r2.body.data.some(s => r1.body.data.find(x => x.id === s.id)));

  const r3 = await get('/api/services?offset=100');
  t('offset past end -> empty array', Array.isArray(r3.body?.data) && r3.body.data.length === 0);
  t('offset past end still 200', r3.status === 200);
  t('total unaffected by offset', r3.body?.total === 6);

  const r4 = await get('/api/services?limit=1000');
  t('max limit accepted', r4.status === 200);
}

sec('5. Invalid list parameters -> 400');
for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'], ['limit=abc','limit not a number'],
                        ['limit=1.5','limit not an integer'], ['offset=-1','offset negative'], ['offset=xyz','offset not a number']]) {
  const r = await get('/api/services?' + q);
  t(`${why} -> 400`, r.status === 400, { q, status: r.status });
  t(`${why} -> invalid_parameter`, r.body?.error?.code === 'invalid_parameter', r.body?.error);
  t(`${why} -> no data key on failure`, !('data' in r.body));
}

sec('6. GET /api/services/:id — detail');
{
  const r = await get('/api/services/SRV-9001');
  t('200', r.status === 200, r.status);
  t('no stray ok flag on detail', !('ok' in r.body));
  t('data is an object, not an array', r.body?.data && !Array.isArray(r.body.data));
  t('id matches', r.body?.data?.id === 'SRV-9001');
  const fromList = list.data.find(s => s.id === 'SRV-9001');
  t('detail record identical to list record', JSON.stringify(r.body.data) === JSON.stringify(fromList));
  t('no list meta on detail', r.body.count === undefined && r.body.total === undefined && r.body.limit === undefined);

  const r2 = await get('/api/services/SRV-9002');
  t('sparse detail keeps estTime null', r2.body?.data?.estTime === null);
  t('sparse detail omits updatedAt', !('updatedAt' in r2.body.data));
}

sec('7. Detail error paths');
{
  const r404 = await get('/api/services/SRV-8888');
  t('unknown id -> 404', r404.status === 404, r404.status);
  t('404 code', r404.body?.error?.code === 'not_found', r404.body?.error);
  t('404 message names a service', r404.body?.error?.message === 'No service with that id.', r404.body?.error?.message);

  const rWrong = await get('/api/services/VEH-9001');
  t('well-formed id from another collection -> 404 not 400', rWrong.status === 404, rWrong.status);
  t('cross-collection 404 message', rWrong.body?.error?.message === 'No service with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['SRV-','no number'], ['-9001','no prefix'],
                           ['SRVICES-9001','prefix too long'], ['S-1','prefix too short'], ['SRV-99999999999','number too long']]) {
    const r = await get('/api/services/' + encodeURIComponent(id));
    t(`${why} -> 400`, r.status === 400, { id, status: r.status });
    t(`${why} -> invalid_id`, r.body?.error?.code === 'invalid_id', r.body?.error);
  }

  const rEmpty = await get('/api/services/');
  t('trailing slash -> 400 not 404', rEmpty.status === 400, rEmpty.status);
  t('trailing slash code', rEmpty.body?.error?.code === 'invalid_id');

  const rBadEscape = await fetch(BASE + '/api/services/%zz');
  t('malformed percent-escape -> 400', rBadEscape.status === 400, rBadEscape.status);

  const rInject = await get('/api/services/' + encodeURIComponent("SRV-9001' OR '1'='1"));
  t('SQL-ish id rejected by validator -> 400', rInject.status === 400, rInject.status);
  const after = await get('/api/services');
  t('table intact after injection attempt', after.body?.total === 6, after.body?.total);
}

sec('8. Method handling');
for (const m of ['POST','PUT','DELETE','PATCH']) {
  const rl = await get('/api/services', { method: m });
  t(`${m} list -> 405`, rl.status === 405, rl.status);
  t(`${m} list sets Allow: GET`, rl.allow === 'GET', rl.allow);
  const rd = await get('/api/services/SRV-9001', { method: m });
  t(`${m} detail -> 405`, rd.status === 405, rd.status);
  t(`${m} detail sets Allow: GET`, rd.allow === 'GET', rd.allow);
}
{
  const r = await get('/api/services', { method: 'HEAD' });
  t('HEAD -> 405 (only GET is implemented)', r.status === 405, r.status);
}

sec('9. Customers regression — unchanged by the shared factory');
{
  const r = await get('/api/customers');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  t('total 2', r.body?.total === 2);
  t('meta keys unchanged', JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  const c = r.body.data.find(x => x.id === 'CUS-9001');
  t('full customer record shape', JSON.stringify(c) === JSON.stringify({
    id:'CUS-9001', name:'B4 Test Customer', phone:'01900000001', altPhone:'01900000002',
    email:'b4@example.test', address:'Dhaka', notes:'regression row', status:'Active',
    createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), c);
  const sparse = r.body.data.find(x => x.id === 'CUS-9002');
  t('sparse customer nulls -> ""', sparse.altPhone === '' && sparse.email === '' && sparse.address === '' && sparse.notes === '');
  t('sparse customer omits updatedAt', !('updatedAt' in sparse));
  t('phone_digits never leaks', !('phoneDigits' in c) && !('phone_digits' in c), Object.keys(c));
  t('ordering newest first', JSON.stringify(r.body.data.map(x => x.id)) === JSON.stringify(['CUS-9002','CUS-9001']));

  const d = await get('/api/customers/CUS-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(c));
  const d404 = await get('/api/customers/CUS-8888');
  t('customers 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No customer with that id.', d404.body?.error);
  const d400 = await get('/api/customers/bad');
  t('customers 400 unchanged', d400.status === 400 && d400.body?.error?.code === 'invalid_id');
  const dCross = await get('/api/customers/SRV-9001');
  t('services id on customers route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No customer with that id.');
  const p = await get('/api/customers?limit=1&offset=1');
  t('customers pagination unchanged', p.body?.count === 1 && p.body?.total === 2 && p.body.data[0].id === 'CUS-9001', p.body);
  const m405 = await get('/api/customers', { method: 'POST' });
  t('customers 405 unchanged', m405.status === 405 && m405.allow === 'GET');
}

sec('10. Vehicles regression — unchanged by the shared factory');
{
  const r = await get('/api/vehicles');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  const v = r.body.data.find(x => x.id === 'VEH-9001');
  t('full vehicle record shape', JSON.stringify(v) === JSON.stringify({
    id:'VEH-9001', customerId:'CUS-9001', regNo:'B4-TEST-01', brand:'Toyota', model:'Corolla',
    year:2019, color:'White', vin:'VIN9001', engineNo:'ENG9001', chassisNo:'CHS9001', mileage:52000,
    fuelType:'Petrol', transmission:'Automatic', nextServiceDate:'2026-12-01', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), v);
  const sparse = r.body.data.find(x => x.id === 'VEH-9002');
  t('vehicle year null, not 0', sparse.year === null, sparse.year);
  t('vehicle mileage null, not 0', sparse.mileage === null, sparse.mileage);
  t('vehicle text nulls -> ""', sparse.color === '' && sparse.vin === '' && sparse.fuelType === '' && sparse.nextServiceDate === '');
  t('vehicle omits updatedAt', !('updatedAt' in sparse));
  const d = await get('/api/vehicles/VEH-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(v));
  const d404 = await get('/api/vehicles/VEH-8888');
  t('vehicles 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No vehicle with that id.', d404.body?.error);
  const dCross = await get('/api/vehicles/SRV-9001');
  t('services id on vehicles route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No vehicle with that id.');
  const m405 = await get('/api/vehicles/VEH-9001', { method: 'DELETE' });
  t('vehicles 405 unchanged', m405.status === 405 && m405.allow === 'GET');
}

sec('10b. GET /api/mechanics — the new collection, over real HTTP');
{
  const r = await get('/api/mechanics');
  t('200', r.status === 200, r.status);
  t('count 3', r.body?.count === 3, r.body?.count);
  t('total 3', r.body?.total === 3, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first, id DESC tie-break',
    JSON.stringify(r.body.data.map(m => m.id)) === JSON.stringify(['MEC-9002','MEC-9001','MEC-9003']),
    r.body.data.map(m => m.id));

  const byId = Object.fromEntries(r.body.data.map(m => [m.id, m]));
  const full = byId['MEC-9001'];
  t('full mechanic record shape', JSON.stringify(full) === JSON.stringify({
    id:'MEC-9001', name:'B5 Full Mechanic', phone:'01911000001', altPhone:'01911000002',
    email:'b5@example.test', address:'Uttara, Dhaka', specialization:'Engine & Transmission',
    experience:12, joiningDate:'2021-03-15', employmentType:'Full Time', salaryType:'Monthly',
    salary:32000, commissionRate:5.5, availability:'Available', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('commissionRate keeps its decimal', full.commissionRate === 5.5, full.commissionRate);

  const sparse = byId['MEC-9002'];
  t('NULL text -> ""',
    sparse.altPhone === '' && sparse.email === '' && sparse.address === ''
      && sparse.specialization === '' && sparse.joiningDate === '' && sparse.notes === '');
  t('NULL experience stays null, not 0', sparse.experience === null, sparse.experience);
  t('NULL salary stays null, not 0', sparse.salary === null, sparse.salary);
  t('NULL commissionRate stays null, not 0', sparse.commissionRate === null, sparse.commissionRate);
  t('NULL employmentType -> "", API invents no default', sparse.employmentType === '', sparse.employmentType);
  t('NULL salaryType -> "", API invents no default', sparse.salaryType === '', sparse.salaryType);
  t('NULL availability -> "", API invents no default', sparse.availability === '', sparse.availability);
  t('sparse mechanic omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const zeroed = byId['MEC-9003'];
  t('stored 0 experience stays 0', zeroed.experience === 0, zeroed.experience);
  t('stored 0 salary stays 0', zeroed.salary === 0, zeroed.salary);
  t('stored 0 commissionRate stays 0', zeroed.commissionRate === 0, zeroed.commissionRate);
  t('0 is distinguishable from null over the wire',
    zeroed.salary === 0 && sparse.salary === null, { zero: zeroed.salary, nul: sparse.salary });
  t('Inactive status preserved', zeroed.status === 'Inactive', zeroed.status);

  const p1 = await get('/api/mechanics?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 3', p1.body?.total === 3, p1.body?.total);
  const p2 = await get('/api/mechanics?limit=2&offset=2');
  t('offset=2 returns the last one', JSON.stringify(p2.body.data.map(m => m.id)) === JSON.stringify(['MEC-9003']),
    p2.body.data.map(m => m.id));
  t('pages do not overlap', !p2.body.data.some(m => p1.body.data.find(x => x.id === m.id)));
  const p3 = await get('/api/mechanics?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);

  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/mechanics?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  const d = await get('/api/mechanics/MEC-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dSparse = await get('/api/mechanics/MEC-9002');
  t('sparse detail keeps salary null', dSparse.body?.data?.salary === null, dSparse.body?.data?.salary);

  const d404 = await get('/api/mechanics/MEC-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a mechanic', d404.body?.error?.message === 'No mechanic with that id.', d404.body?.error?.message);
  const dCross = await get('/api/mechanics/SRV-9001');
  t('another collection\'s id -> 404, not 400', dCross.status === 404, dCross.status);
  t('cross-collection 404 message', dCross.body?.error?.message === 'No mechanic with that id.');
  const mOnCust = await get('/api/customers/MEC-9001');
  t('mechanics id on the customers route -> 404', mOnCust.status === 404 && mOnCust.body?.error?.message === 'No customer with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['MEC-','no number'], ['-9001','no prefix'],
                           ['MECHANICS-9001','prefix too long'], ['M-1','prefix too short']]) {
    const bad = await get('/api/mechanics/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/mechanics/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/mechanics/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  const inject = await get('/api/mechanics/' + encodeURIComponent("MEC-9001' OR '1'='1"));
  t('SQL-ish id rejected -> 400', inject.status === 400, inject.status);
  const after = await get('/api/mechanics');
  t('mechanics table intact after injection attempt', after.body?.total === 3, after.body?.total);

  for (const m of ['POST','PUT','DELETE','PATCH']) {
    const rl = await get('/api/mechanics', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET', { status: rl.status, allow: rl.allow });
    const rd = await get('/api/mechanics/MEC-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET', { status: rd.status, allow: rd.allow });
  }
}

sec('11. Collections stay separate over the wire');
{
  const [s, c, v, m] = await Promise.all([
    get('/api/services'), get('/api/customers'), get('/api/vehicles'), get('/api/mechanics')]);
  t('services returns only SRV ids', s.body.data.every(x => x.id.startsWith('SRV-')));
  t('customers returns only CUS ids', c.body.data.every(x => x.id.startsWith('CUS-')));
  t('vehicles returns only VEH ids', v.body.data.every(x => x.id.startsWith('VEH-')));
  t('services rows have no customer fields', !s.body.data.some(x => 'phone' in x || 'regNo' in x));
  t('customers rows have no service fields', !c.body.data.some(x => 'price' in x || 'estTime' in x));
  t('vehicles rows have no service fields', !v.body.data.some(x => 'price' in x || 'estTime' in x));
  t('mechanics returns only MEC ids', m.body.data.every(x => x.id.startsWith('MEC-')));
  t('mechanics rows have no vehicle or service fields',
    !m.body.data.some(x => 'regNo' in x || 'price' in x || 'estTime' in x));
  t('salary never appears outside mechanics',
    ![...s.body.data, ...c.body.data, ...v.body.data].some(x => 'salary' in x || 'commissionRate' in x));
}

sec('12. Unknown routes');
{
  // Pick a collection the router does NOT know, derived from what health
  // advertises rather than hardcoded. B-4 hardcoded /api/mechanics here and
  // B-5 turned it into a real route, so the assertion started failing for the
  // wrong reason. Deriving it means the next phase inherits this unchanged.
  const advertised = (await get('/api/health')).body?.data?.routes ?? [];
  const unregistered = ['parts', 'invoices', 'payments', 'expenses', 'widgets']
    .find(name => !advertised.includes(`GET /api/${name}`));
  t('a collection to probe was found', Boolean(unregistered), advertised);

  const r = await get(`/api/${unregistered}`);
  t(`unregistered collection /api/${unregistered} -> 404`, r.status === 404, r.status);
  t('404 advertises exactly what health advertises',
    JSON.stringify(r.body?.error?.available) === JSON.stringify(advertised),
    { from404: r.body?.error?.available, fromHealth: advertised });
  t('every advertised route is a GET', advertised.every(x => x.startsWith('GET ')), advertised);

  const r2 = await get('/api/services/extra/segments');
  t('deep path under services -> 400 or 404, never 500', r2.status === 400 || r2.status === 404, r2.status);
  const r3 = await get('/nope');
  t('non-api path -> 404', r3.status === 404);
}

console.log(`\nAPI integration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
